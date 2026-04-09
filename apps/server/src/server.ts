import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";
import type { FastifyReply } from "fastify";
import type WebSocket from "ws";
import type nodePty from "node-pty";
import * as z from "zod/v4";

let pty: typeof nodePty;
try {
  // node-pty is CJS with __esModule: true. Under Node.js native ESM
  // (production), .default === module.exports. Under tsx/esbuild (dev),
  // .default is undefined because esbuild respects __esModule and looks
  // for exports.default which doesn't exist. Fall back to the module
  // namespace itself which always has the named exports.
  const m = await import("node-pty");
  pty = (m.default ?? m) as typeof nodePty;
} catch {
  console.error(
    "\n✗ Failed to load node-pty native module.\n" +
    "  This usually means the native addon was not compiled during install.\n" +
    "  Fix: run 'pnpm rebuild node-pty' in the server directory, or ensure\n" +
    "  'node-pty' is listed in pnpm.onlyBuiltDependencies in package.json.\n"
  );
  process.exit(1);
}

import { AgentError, AgentManager } from "./agents/manager.js";
import type { AgentGitContext, AgentRecord, FeedbackRecord } from "./agents/manager.js";
import { loadPersonas, loadPersonaBySlug, assemblePersonaPrompt } from "./personas/loader.js";
import {
  isPasswordSet,
  setPassword,
  verifyPassword,
  createSession,
  validateSession,
  deleteSession,
  deleteAllSessions,
  changePassword,
  cleanExpiredSessions,
  getOrCreateAuthToken,
  getOrCreateCookieSecret
} from "./auth.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { deleteSetting, getSetting, setSetting } from "./db/settings.js";
import { runCommand } from "@dispatch/shared/lib/run-command.js";
import { handleMcpRequest } from "@dispatch/shared/mcp/server.js";
import { readReleaseStore, writeReleaseStore } from "./release-store.js";
import { StreamManager } from "./stream-manager.js";
import { SlackNotifier } from "./notifications/slack.js";
import { JobNotifier } from "./notifications/job-notifier.js";
import { FocusTracker } from "./focus-tracker.js";
import { TerminalTokenStore } from "./terminal/token-store.js";
import { AGENT_TYPES, getEnabledAgentTypes, setEnabledAgentTypes } from "./agent-type-settings.js";
import { isPinType, validatePinValue } from "./pins.js";
import { JobService } from "./jobs/service.js";
import { randomUUID } from "node:crypto";
import { ReleaseLogStreamProcessor } from "./release-log-stream.js";
import {
  computeActivityStats,
  computeDailyStatus,
  computeWorkingTimeByProject,
  type ActivityEventRow,
} from "./activity-metrics.js";

const config = loadConfig();
const app = Fastify({
  logger: true,
  ...(config.tls && { https: { cert: config.tls.cert, key: config.tls.key } }),
});
const pool = createPool(config);
const agentManager = new AgentManager(pool, app.log, config);
const focusTracker = new FocusTracker();
const slackNotifier = new SlackNotifier(pool, app.log);
slackNotifier.setFocusCheck((agentId) => focusTracker.isFocused(agentId));
const terminalTokenStore = new TerminalTokenStore(60_000);
const jobService = new JobService(pool, agentManager, app.log, config);
const jobNotifier = new JobNotifier(pool, app.log);
const JOB_TERMINAL_STATUSES = new Set(["completed", "failed", "timed_out", "crashed"]);
jobService.onRunStateChange((run) => {
  void jobNotifier.onJobRunStateChange(run).catch((err) => {
    app.log.warn({ err, runId: run.id }, "Job run state notification failed");
  });
  // Auto-archive job agents when the run reaches a terminal state.
  // needs_input is excluded — user may need to interact with the agent.
  if (JOB_TERMINAL_STATUSES.has(run.status) && run.agentId) {
    void autoArchiveJobAgent(run.agentId).catch((err) => {
      app.log.warn({ err, agentId: run.agentId }, "Auto-archive of job agent failed");
    });
  }
});
// Suppress agent-level Slack notifications for job agents (job notifier handles those).
// Job agents are named "job-*" — skip the DB lookup for regular agents.
agentManager.onLatestEvent((agent) => {
  if (!agent.name?.startsWith("job-")) {
    void slackNotifier.onAgentEvent(agent).catch((err) => {
      app.log.warn({ err, agentId: agent.id }, "Slack agent notification failed");
    });
    return;
  }
  void jobService.getLatestRunForAgent(agent.id).then((run) => {
    if (!run) return slackNotifier.onAgentEvent(agent);
  }).catch((err) => {
    app.log.warn({ err, agentId: agent.id }, "Job agent notification lookup failed");
  });
});
const activeArchives = new Set<Promise<void>>();
const archivingAgentIds = new Set<string>();

async function autoArchiveJobAgent(agentId: string): Promise<void> {
  if (archivingAgentIds.has(agentId)) return;
  try {
    const agent = await agentManager.beginArchive(agentId, "auto");
    uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(agent) });
    archivingAgentIds.add(agentId);
    const archivePromise = agentManager.executeArchive(agentId, {
      onPhaseChange: (updated) => {
        uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(updated) });
      },
      onComplete: (deletedIds) => {
        for (const deletedId of deletedIds) {
          uiEventBroker.publish({ type: "agent.deleted", agentId: deletedId });
          archivingAgentIds.delete(deletedId);
        }
        activeArchives.delete(archivePromise);
      },
      onError: () => {
        archivingAgentIds.delete(agentId);
        activeArchives.delete(archivePromise);
      },
    });
    activeArchives.add(archivePromise);
  } catch (err) {
    app.log.warn({ err, agentId }, "Auto-archive of job agent failed");
  }
}

const AGENT_LATEST_EVENT_TYPES = ["working", "blocked", "waiting_user", "done", "idle"] as const;
const CODEX_FULL_ACCESS_ARG = "--dangerously-bypass-approvals-and-sandbox";
const CLAUDE_FULL_ACCESS_ARG = "--dangerously-skip-permissions";
type AgentLatestEventType = (typeof AGENT_LATEST_EVENT_TYPES)[number];
type ActivityGranularity = "day" | "week" | "month";
type UiEvent =
  | { type: "snapshot"; agents: AgentRecord[] }
  | { type: "agent.upsert"; agent: AgentRecord }
  | { type: "agent.deleted"; agentId: string }
  | { type: "media.changed"; agentId: string }
  | { type: "media.seen"; agentId: string; keys: string[] }
  | { type: "stream.started"; agentId: string }
  | { type: "stream.stopped"; agentId: string }
  | { type: "feedback.created"; agentId: string; feedback: import("./agents/manager.js").FeedbackRecord }
  | { type: "feedback.updated"; agentId: string; feedback: import("./agents/manager.js").FeedbackRecord };

class UiEventBroker {
  private clients = new Set<NodeJS.WritableStream>();
  private nextId = 1;

  subscribe(stream: NodeJS.WritableStream): () => void {
    this.clients.add(stream);
    return () => {
      this.clients.delete(stream);
    };
  }

  publish(event: UiEvent): void {
    this.write(event);
  }

  sendSnapshot(stream: NodeJS.WritableStream, agents: AgentRecord[]): void {
    this.write({ type: "snapshot", agents }, stream);
  }

  private write(event: UiEvent, target?: NodeJS.WritableStream): void {
    const payload = `id: ${this.nextId++}\ndata: ${JSON.stringify(event)}\n\n`;
    if (target) {
      target.write(payload);
      return;
    }

    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}

const uiEventBroker = new UiEventBroker();
const streamManager = new StreamManager(
  (agentId, event) => {
    uiEventBroker.publish(
      event === "started"
        ? { type: "stream.started", agentId }
        : { type: "stream.stopped", agentId }
    );
  },
  async (agentId, lastFrame, description) => {
    const agent = await agentManager.getAgent(agentId);
    if (!agent) return;

    const mediaDir = resolveMediaDir(agentId, agent.mediaDir);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `stream-capture-${timestamp}.jpg`;

    await mkdir(mediaDir, { recursive: true });
    await writeFile(path.join(mediaDir, fileName), lastFrame);

    await pool.query(
      `INSERT INTO media (agent_id, file_name, source, size_bytes, description)
       VALUES ($1, $2, 'stream', $3, $4)`,
      [agentId, fileName, lastFrame.length, description]
    );

    uiEventBroker.publish({ type: "media.changed", agentId });
  }
);
const PROBE_COMMAND_TIMEOUT_MS = 800;
const GIT_CONTEXT_REFRESH_INTERVAL_MS = 120_000;
const GIT_CONTEXT_REFRESH_CONCURRENCY = 1;
const GIT_CONTEXT_MIN_REQUEUE_MS = 60_000;
const GIT_DIAGNOSTICS_HISTORY_LIMIT = 200;
const pendingGitRefreshAgentIds = new Set<string>();

type ActivityQuery = {
  start: Date | null;
  end: Date | null;
  tz: string;
  granularity: ActivityGranularity;
};

const VALID_GRANULARITIES = new Set<ActivityGranularity>(["day", "week", "month"]);
const FALLBACK_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const VALID_TIMEZONES = new Set(Intl.supportedValuesOf("timeZone"));

function parseActivityQuery(query: Record<string, unknown>): ActivityQuery {
  const startStr = typeof query.start === "string" ? query.start : "";
  const endStr = typeof query.end === "string" ? query.end : "";
  const rawTz = typeof query.tz === "string" && query.tz ? query.tz : FALLBACK_TZ;
  const tz = VALID_TIMEZONES.has(rawTz) ? rawTz : FALLBACK_TZ;
  const gran = typeof query.granularity === "string" ? query.granularity : "day";

  const start = startStr ? new Date(startStr) : null;
  const end = endStr ? new Date(endStr) : null;

  return {
    start: start && !Number.isNaN(start.getTime()) ? start : null,
    end: end && !Number.isNaN(end.getTime()) ? end : null,
    tz,
    granularity: VALID_GRANULARITIES.has(gran as ActivityGranularity)
      ? (gran as ActivityGranularity)
      : "day",
  };
}

function timeRangeClause(
  aq: ActivityQuery,
  column: string,
  paramOffset = 0
): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (aq.start) {
    params.push(aq.start);
    conditions.push(`${column} >= $${paramOffset + params.length}`);
  }
  if (aq.end) {
    params.push(aq.end);
    conditions.push(`${column} <= $${paramOffset + params.length}`);
  }
  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

function dateTruncTz(granularity: ActivityGranularity, column: string, tz: string): string {
  return `date_trunc('${granularity}', ${column} AT TIME ZONE '${tz.replace(/'/g, "''")}')::date::text`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

async function loadScopedActivityEvents(
  aq: ActivityQuery
): Promise<{ rows: ActivityEventRow[]; rangeStart: Date | null }> {
  const rangeStart = aq.start;
  const eventFilter = timeRangeClause(aq, "created_at");

  const inRangeResult = await pool.query<ActivityEventRow>(
    `SELECT agent_id, event_type, created_at
     FROM agent_events
     ${eventFilter.clause}
     ORDER BY agent_id, created_at`,
    eventFilter.params
  );

  if (!rangeStart) {
    return { rows: inRangeResult.rows, rangeStart: null };
  }

  const boundaryResult = await pool.query<ActivityEventRow>(
    `SELECT DISTINCT ON (agent_id) agent_id, event_type, created_at
     FROM agent_events
     WHERE created_at < $1
     ORDER BY agent_id, created_at DESC`,
    [rangeStart]
  );

  const rows = [...boundaryResult.rows, ...inRangeResult.rows].sort((a, b) => {
    const agentCompare = a.agent_id.localeCompare(b.agent_id);
    if (agentCompare !== 0) return agentCompare;
    return a.created_at.getTime() - b.created_at.getTime();
  });

  return { rows, rangeStart };
}
const activeGitRefreshAgentIds = new Set<string>();
const pendingGitRefreshEnqueuedAt = new Map<string, number>();
const gitRefreshDurationsMs: number[] = [];
const gitRefreshAgentDiagnostics = new Map<
  string,
  {
    lastQueuedAt: number | null;
    lastStartedAt: number | null;
    lastCompletedAt: number | null;
    lastDurationMs: number | null;
    lastResult: "updated" | "unchanged" | "probe_error" | "failed" | "skipped" | null;
    lastError: string | null;
  }
>();
const gitRefreshCounters = {
  enqueued: 0,
  started: 0,
  completed: 0,
  updated: 0,
  unchanged: 0,
  probeErrors: 0,
  failed: 0,
  timedOut: 0,
  skipped: 0
};
let gitContextRefreshTimer: NodeJS.Timeout | null = null;

const AGENT_STATUS_RECONCILE_INTERVAL_MS = 30_000;
let agentStatusReconcileTimer: NodeJS.Timeout | null = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRootDir = path.resolve(__dirname, "..");
const repoRootDir = path.resolve(appRootDir, "../..");
if (!existsSync(path.join(repoRootDir, "pnpm-workspace.yaml"))) {
  throw new Error(`repoRootDir "${repoRootDir}" does not contain pnpm-workspace.yaml — monorepo layout may have changed`);
}
const releaseNotesFile = path.join(repoRootDir, "release-notes", "current.md");
const webDistDir = path.resolve(repoRootDir, "apps/web/dist");
const legacyPublicDir = path.resolve(repoRootDir, "public");
const staticDir = existsSync(webDistDir) ? webDistDir : legacyPublicDir;

// ---------------------------------------------------------------------------
// Icon color templating — rewrite index.html and manifest for active color
// ---------------------------------------------------------------------------
const VALID_ICON_COLORS = ["teal", "blue", "purple", "red", "orange", "amber", "pink", "cyan"] as const;
type IconColor = typeof VALID_ICON_COLORS[number];
const DEFAULT_ICON_COLOR: IconColor = "teal";
const ICON_COLOR_KEY = "icon_color";

const indexHtmlPath = path.join(staticDir, "index.html");
const manifestPath = path.join(staticDir, "manifest.webmanifest");
const indexHtmlTemplate = existsSync(indexHtmlPath) ? readFileSync(indexHtmlPath, "utf-8") : "";
const manifestTemplate = existsSync(manifestPath) ? readFileSync(manifestPath, "utf-8") : "";

let cachedIconColor: IconColor = DEFAULT_ICON_COLOR;
let cachedIndexHtml: string = indexHtmlTemplate;
let cachedManifest: string = manifestTemplate;

function rewriteForColor(color: IconColor): void {
  cachedIconColor = color;
  if (color === DEFAULT_ICON_COLOR) {
    cachedIndexHtml = indexHtmlTemplate;
    cachedManifest = manifestTemplate;
  } else {
    cachedIndexHtml = indexHtmlTemplate.replaceAll("/icons/teal/", `/icons/${color}/`);
    cachedManifest = manifestTemplate.replaceAll("/icons/teal/", `/icons/${color}/`);
  }
}

function withStreamFlag<T extends AgentRecord>(agent: T): T & { hasStream: boolean } {
  return { ...agent, hasStream: streamManager.hasStream(agent.id) };
}

type GitHubReleaseMetadata = {
  tag: string;
  publishedAt: string;
  url: string;
  body?: string | null;
};

async function getAppVersionInfo(): Promise<{
  releaseTag: string | null;
  version: string | null;
  gitSha: string | null;
  releaseNotes: string | null;
  releaseUrl: string | null;
}> {
  const record = await readReleaseStore().catch(() => null);

  let version: string | null = null;
  try {
    const packageJson = JSON.parse(await readFile(path.join(appRootDir, "package.json"), "utf8")) as {
      version?: unknown;
    };
    if (typeof packageJson.version === "string" && packageJson.version.trim()) {
      version = packageJson.version.trim();
    }
  } catch {}

  let gitSha: string | null = null;
  try {
    const gitResult = await runCommand(
      "git",
      ["-C", repoRootDir, "rev-parse", "--short=12", "HEAD"],
      { allowedExitCodes: [0, 128] }
    );
    if (gitResult.exitCode === 0) {
      gitSha = gitResult.stdout.trim() || null;
    }
  } catch {}

  const releaseTag = record?.tag ?? null;
  const releaseNotes = await readFile(releaseNotesFile, "utf8")
    .then((raw) => raw.trim() || null)
    .catch(() => null);
  const releaseUrl = releaseTag ? `https://github.com/${await getGitHubRepo()}/releases/tag/${releaseTag}` : null;

  return {
    releaseTag,
    version,
    gitSha,
    releaseNotes,
    releaseUrl
  };
}

// ---------------------------------------------------------------------------
// Release manager
// ---------------------------------------------------------------------------

const RELEASE_VERSION_TYPES = ["patch", "minor", "major"] as const;
type ReleaseVersionType = (typeof RELEASE_VERSION_TYPES)[number];
type ReleasePhase = "preflight" | "triggering" | "watching" | "fetching" | "deploying" | "restarting" | "done" | "failed";
type ReleaseJobType = "create" | "update";

type ReleaseJob = {
  jobType: ReleaseJobType;
  versionType: ReleaseVersionType | null;
  phase: ReleasePhase;
  startedAt: string;
  log: string[];
  runUrl: string | null;
  tag: string | null;
  error: string | null;
};

type ReleaseStreamEvent =
  | { type: "snapshot"; job: ReleaseJob | null }
  | { type: "log"; line: string }
  | { type: "log.replace"; line: string }
  | { type: "log.rewind"; count: number }
  | { type: "phase"; phase: ReleasePhase; error?: string }
  | { type: "runUrl"; url: string }
  | { type: "tag"; tag: string };

let activeReleaseJob: ReleaseJob | null = null;
const releaseStreamClients = new Set<NodeJS.WritableStream>();

const serverDir = process.env.DISPATCH_SERVER_DIR ?? path.join(os.homedir(), ".dispatch", "server");

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

function setReleasePhase(job: ReleaseJob, phase: ReleasePhase, error?: string): void {
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
      stdio: ["ignore", "pipe", "pipe"]
    });

    const processor = new ReleaseLogStreamProcessor({
      append: (line) => appendReleaseLog(job, line),
      replace: (line) => replaceReleaseLog(job, line),
      rewind: (count) => rewindReleaseLog(job, count)
    }, onLine);

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
    const result = await runCommand("git", ["-C", serverDir, "remote", "get-url", "origin"]);
    const url = result.stdout;
    const match = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
    if (match?.[1]) {
      return match[1];
    }
  } catch {
    // fall through
  }
  return "selfcontained/dispatch";
}

// Cached admin permission check — lasts for the server process lifetime
let cachedIsAdmin: boolean | null = null;

async function checkIsAdmin(): Promise<boolean> {
  if (cachedIsAdmin !== null) return cachedIsAdmin;
  try {
    await runCommand("gh", ["--version"]);
    const repo = await getGitHubRepo();
    const result = await runCommand("gh", [
      "repo", "view", repo,
      "--json", "viewerPermission",
      "--jq", ".viewerPermission"
    ]);
    cachedIsAdmin = result.stdout.trim() === "ADMIN";
  } catch {
    cachedIsAdmin = false;
  }
  return cachedIsAdmin;
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

async function fetchReleaseMetadata(tag: string): Promise<GitHubReleaseMetadata | null> {
  try {
    const repo = await getGitHubRepo();
    const result = await runCommand("gh", [
      "release", "view", tag,
      "--repo", repo,
      "--json", "tagName,publishedAt,url,body"
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
      body: typeof data.body === "string" ? data.body.trim() : null
    };
  } catch {
    return null;
  }
}

async function fetchLatestReleaseMetadata(tag: string): Promise<GitHubReleaseMetadata | null> {
  return fetchReleaseMetadata(tag);
}

/**
 * Try to deploy from a pre-built release tarball attached to the GitHub release.
 * Returns true on success, false if the artifact isn't available (caller falls
 * back to building from source).
 */
async function deployFromArtifact(job: ReleaseJob, tag: string): Promise<boolean> {
  // Need gh CLI to download release assets
  try {
    await runCommand("gh", ["--version"]);
  } catch {
    appendReleaseLog(job, "gh CLI not available, skipping artifact download");
    return false;
  }

  let repo: string;
  try {
    repo = await getGitHubRepo();
  } catch {
    appendReleaseLog(job, "could not resolve GitHub repo, skipping artifact download");
    return false;
  }

  // Use a random temp directory to avoid TOCTOU attacks on a predictable path
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dispatch-release-"));
  const tarball = path.join(tmpDir, "release.tar.gz");

  try {
    appendReleaseLog(job, `==> downloading release artifact for ${tag}`);
    try {
      await runCommand("gh", [
        "release", "download", tag,
        "--pattern", "dispatch-release.tar.gz",
        "--output", tarball,
        "--repo", repo
      ]);
    } catch {
      appendReleaseLog(job, "no release artifact found for this tag");
      return false;
    }

    appendReleaseLog(job, `==> checking out ${tag} (for version metadata)`);
    await runCommand("git", ["-C", serverDir, "checkout", tag]);

    // Validate tarball contents before extraction — reject entries with path
    // traversal (../) or absolute paths. macOS bsdtar does NOT block these by
    // default, so this is a real risk if a compromised release artifact is uploaded.
    appendReleaseLog(job, "==> validating artifact contents");
    const listing = await runCommand("tar", ["tzf", tarball]);
    const unsafeEntries = listing.stdout
      .split("\n")
      .filter((entry) => entry.startsWith("/") || entry.includes("../"));
    if (unsafeEntries.length > 0) {
      throw new Error(
        `Release artifact contains unsafe paths: ${unsafeEntries.slice(0, 5).join(", ")}`
      );
    }

    appendReleaseLog(job, "==> extracting pre-built artifact");
    await runCommand("tar", ["xzf", tarball, "--no-same-owner", "-C", serverDir]);

    appendReleaseLog(job, "==> installing dependencies (native modules only)");
    await streamProcess("pnpm", ["install", "--frozen-lockfile"], { cwd: serverDir }, job);

    appendReleaseLog(job, "==> deployed from pre-built artifact (no build needed)");
    return true;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Shared deploy logic: checkout tag, install, build, write record, restart */
async function deployTag(job: ReleaseJob, tag: string): Promise<void> {
  setReleasePhase(job, "deploying");
  appendReleaseLog(job, `==> deploying ${tag}`);

  // Try the pre-built release artifact first; fall back to source build
  const usedArtifact = await deployFromArtifact(job, tag);

  if (!usedArtifact) {
    appendReleaseLog(job, "==> falling back to build from source");

    appendReleaseLog(job, `==> checking out ${tag}`);
    await runCommand("git", ["-C", serverDir, "checkout", tag]);

    appendReleaseLog(job, "==> installing dependencies");
    await streamProcess("pnpm", ["install", "--frozen-lockfile"], { cwd: serverDir }, job);

    appendReleaseLog(job, "==> building from source");
    await streamProcess("pnpm", ["run", "build"], { cwd: serverDir }, job);
  }

  // Write release record BEFORE the restart — after the restart our
  // process is dead and can't write anything.
  await writeReleaseStore({ tag, deployedAt: new Date().toISOString() });
  appendReleaseLog(job, `==> wrote release record for ${tag}`);

  // Tell SSE clients we're about to restart
  setReleasePhase(job, "restarting");
  appendReleaseLog(job, "==> restarting service");

  // Trigger the restart. launchctl kill sends SIGKILL to this process
  // (and its process group). KeepAlive ensures launchd restarts it
  // with the newly built code. The UI health-poll takes over from here.
  const uid = process.getuid?.() ?? 501;
  spawn("launchctl", ["kill", "SIGKILL", `gui/${uid}/com.dispatch.server`], {
    detached: true,
    stdio: "ignore"
  }).unref();
}

async function runUpdateJob(job: ReleaseJob): Promise<void> {
  try {
    const tag = job.tag!;

    setReleasePhase(job, "fetching");
    appendReleaseLog(job, "==> fetching tags from origin");
    await runCommand("git", ["-C", serverDir, "fetch", "--tags", "--quiet"]);

    // Verify the tag exists
    try {
      await runCommand("git", ["-C", serverDir, "rev-parse", "--verify", tag]);
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
    // Preflight: check gh CLI is available
    setReleasePhase(job, "preflight");
    try {
      await runCommand("gh", ["--version"]);
    } catch {
      throw new Error("GitHub CLI (gh) is not available. Install it from https://cli.github.com");
    }

    const repo = await getGitHubRepo();

    // Trigger workflow
    setReleasePhase(job, "triggering");
    appendReleaseLog(job, `==> triggering release workflow (version: ${job.versionType})`);

    try {
      await runCommand("gh", [
        "workflow", "run", "release.yml",
        "--repo", repo,
        "--field", `version=${job.versionType}`
      ]);
    } catch (err) {
      throw new Error(`Failed to trigger workflow: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Give GitHub a moment to register the run
    await new Promise((r) => setTimeout(r, 3000));

    // Get the run ID
    const runIdResult = await runCommand("gh", [
      "run", "list",
      "--repo", repo,
      "--workflow", "release.yml",
      "--limit", "1",
      "--json", "databaseId",
      "--jq", ".[0].databaseId"
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

    // Watch the workflow
    setReleasePhase(job, "watching");
    try {
      await streamProcess("gh", ["run", "watch", runId, "--repo", repo], { env: { GH_FORCE_TTY: "120" } }, job);
    } catch {
      throw new Error(`GitHub Actions workflow failed. See ${runUrl}`);
    }

    // Fetch tags and find the latest
    await runCommand("git", ["-C", serverDir, "fetch", "--tags", "--quiet"]);
    const tagsResult = await runCommand("git", ["-C", serverDir, "tag", "--sort=-version:refname"]);
    const tag = tagsResult.stdout.split("\n").find((t) => t.startsWith("v")) ?? "";
    if (!tag) {
      throw new Error("Could not determine release tag after workflow completed");
    }

    job.tag = tag;
    broadcastReleaseEvent({ type: "tag", tag });
    appendReleaseLog(job, `==> release ${tag} created successfully`);

    // Release creation is done — the user can update separately.
    setReleasePhase(job, "done");
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (activeReleaseJob) {
      activeReleaseJob.error = error;
    }
    setReleasePhase(job, "failed", error);
  }
}

// In-memory cache: null = unknown, true/false = password set/not-set.
let passwordSetCache: boolean | null = null;

async function isPasswordSetCached(): Promise<boolean> {
  if (passwordSetCache === null) {
    passwordSetCache = await isPasswordSet(pool);
  }
  return passwordSetCache;
}

function invalidatePasswordSetCache(): void {
  passwordSetCache = null;
}

const SESSION_COOKIE = "dispatch_session";
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60; // 30 days

const SetupBodySchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters."),
});
const LoginBodySchema = z.object({
  password: z.string().min(1, "Password is required."),
});
const ChangePasswordBodySchema = z.object({
  currentPassword: z.string().min(1, "Current password is required."),
  newPassword: z.string().min(8, "New password must be at least 8 characters."),
});
function resolveTilde(raw: string): string {
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  if (raw === "~") return os.homedir();
  return raw;
}
const directoryField = z.string().min(1, "Job directory is required.").transform(resolveTilde);
const RunJobBodySchema = z.object({
  name: z.string().min(1, "Job name is required."),
  directory: directoryField,
  wait: z.boolean().optional(),
});
const JobEnableDisableBodySchema = z.object({
  name: z.string().min(1, "Job name is required."),
  directory: directoryField,
});
const AddJobBodySchema = JobEnableDisableBodySchema.extend({
  displayName: z.string().optional(),
  prompt: z.string().nullable().optional(),
  schedule: z.string().nullable().optional(),
  timeoutMs: z.number().int().positive().optional(),
  needsInputTimeoutMs: z.number().int().positive().optional(),
  agentType: z.enum(AGENT_TYPES).optional(),
  useWorktree: z.boolean().optional(),
  branchName: z.string().nullable().optional(),
  fullAccess: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
const JobHistoryParamsSchema = z.object({
  name: z.string().min(1, "Job name is required."),
  directory: directoryField,
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

async function registerRoutes() {
  const cookieSecret = await getOrCreateCookieSecret(pool);
  await app.register(fastifyCookie, { secret: cookieSecret });
  await app.register(fastifyMultipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  await app.register(fastifyWebsocket);
  await app.register(fastifyRateLimit, { global: false });

  // Initialize icon color from DB before serving any requests
  const storedIconColor = await getSetting(pool, ICON_COLOR_KEY);
  if (storedIconColor && (VALID_ICON_COLORS as readonly string[]).includes(storedIconColor)) {
    rewriteForColor(storedIconColor as IconColor);
  }

  // Serve templated index.html and manifest before static files so they take priority
  const noCacheHeaders = { "Cache-Control": "no-cache, no-store, must-revalidate" };

  app.get("/", async (_, reply) => {
    return reply.type("text/html").headers(noCacheHeaders).send(cachedIndexHtml);
  });

  app.get("/index.html", async (_, reply) => {
    return reply.type("text/html").headers(noCacheHeaders).send(cachedIndexHtml);
  });

  app.get("/manifest.webmanifest", async (_, reply) => {
    return reply.type("application/manifest+json").headers(noCacheHeaders).send(cachedManifest);
  });

  await app.register(fastifyStatic, {
    root: staticDir,
    prefix: "/",
    setHeaders(res, filePath) {
      const base = path.basename(filePath);
      if (base === "sw.js") {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      }
    }
  });

  // SPA fallback — serve templated index.html for client-side routes
  app.setNotFoundHandler(async (request, reply) => {
    const url = request.url.split("?")[0];
    if (!url.startsWith("/api/") && !path.extname(url)) {
      return reply.type("text/html").headers(noCacheHeaders).send(cachedIndexHtml);
    }
    return reply.code(404).send({ error: "Not found" });
  });

  // ---------------------------------------------------------------------------
  // Auth hook — runs before every /api/ route except auth + health endpoints
  // ---------------------------------------------------------------------------
  app.addHook("onRequest", async (request, reply) => {
    const url = request.url.split("?")[0];

    // Static files, auth endpoints, health check, and WebSocket endpoints are always open.
    // (WebSocket terminal uses its own short-lived token for auth.)
    if (!url.startsWith("/api/")) return;
    if (url.startsWith("/api/v1/auth/")) return;
    if (url === "/api/v1/health") return;
    if (url === "/api/v1/app/branding") return;
    if (/^\/api\/v1\/agents\/[^/]+\/terminal\/ws$/.test(url)) return;

    // If no password is set, all routes are open (first-run mode).
    if (!(await isPasswordSetCached())) return;

    // Bearer token is accepted on all API routes (for MCP agents, scripts, etc.)
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      if (token === config.authToken) {
        return;
      }
    }

    // Session cookie
    const signed = request.cookies[SESSION_COOKIE];
    if (signed) {
      const unsigned = request.unsignCookie(signed);
      if (unsigned.valid && unsigned.value && await validateSession(pool, unsigned.value)) {
        return;
      }
    }

    return reply.code(401).send({ error: "Authentication required." });
  });

  // ---------------------------------------------------------------------------
  // Auth routes
  // ---------------------------------------------------------------------------

  app.get("/api/v1/auth/status", async (request) => {
    const hasPassword = await isPasswordSetCached();
    let authenticated = false;
    if (hasPassword) {
      const signed = request.cookies[SESSION_COOKIE];
      if (signed) {
        const unsigned = request.unsignCookie(signed);
        if (unsigned.valid && unsigned.value) {
          authenticated = await validateSession(pool, unsigned.value);
        }
      }
    } else {
      // No password set — everyone is considered authenticated.
      authenticated = true;
    }
    return { passwordSet: hasPassword, authenticated };
  });

  app.post("/api/v1/auth/setup", { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } }, async (request, reply) => {
    if (await isPasswordSetCached()) {
      return reply.code(400).send({ error: "Password is already set." });
    }
    const parsed = SetupBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    const { password } = parsed.data;
    await setPassword(pool, password);
    invalidatePasswordSetCache();
    const token = await createSession(pool);
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      signed: true,
      sameSite: "lax",
      secure: config.tls !== null,
      maxAge: SESSION_MAX_AGE_S
    });
    return { ok: true };
  });

  app.post("/api/v1/auth/login", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = LoginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    const { password } = parsed.data;
    if (!(await verifyPassword(pool, password))) {
      return reply.code(401).send({ error: "Invalid password." });
    }
    const token = await createSession(pool);
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      signed: true,
      sameSite: "lax",
      secure: config.tls !== null,
      maxAge: SESSION_MAX_AGE_S
    });
    return { ok: true };
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const signed = request.cookies[SESSION_COOKIE];
    if (signed) {
      const unsigned = request.unsignCookie(signed);
      if (unsigned.valid && unsigned.value) {
        await deleteSession(pool, unsigned.value);
      }
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post("/api/v1/auth/change-password", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = ChangePasswordBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    const { currentPassword, newPassword } = parsed.data;
    const changed = await changePassword(pool, currentPassword, newPassword);
    if (!changed) {
      return reply.code(401).send({ error: "Current password is incorrect." });
    }
    await deleteAllSessions(pool);
    const token = await createSession(pool);
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      signed: true,
      sameSite: "lax",
      secure: config.tls !== null,
      maxAge: SESSION_MAX_AGE_S,
    });
    invalidatePasswordSetCache();
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Jobs routes
  // ---------------------------------------------------------------------------

  app.post("/api/v1/jobs/run", async (request, reply) => {
    const parsed = RunJobBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }

    try {
      return await jobService.runJob(parsed.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/api/v1/jobs", async () => {
    return await jobService.listJobs();
  });

  app.post("/api/v1/jobs", async (request, reply) => {
    const parsed = AddJobBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    try {
      return await jobService.addJob(parsed.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ error: message });
    }
  });

  app.patch("/api/v1/jobs", async (request, reply) => {
    const parsed = AddJobBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    try {
      return await jobService.updateJob(parsed.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ error: message });
    }
  });

  app.delete("/api/v1/jobs", async (request, reply) => {
    const parsed = JobEnableDisableBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    try {
      return await jobService.removeJob(parsed.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ error: message });
    }
  });

  app.post("/api/v1/jobs/enable", async (request, reply) => {
    const parsed = JobEnableDisableBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    try {
      return await jobService.enableJob(parsed.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ error: message });
    }
  });

  app.post("/api/v1/jobs/disable", async (request, reply) => {
    const parsed = JobEnableDisableBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    try {
      return await jobService.disableJob(parsed.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/api/v1/jobs/stats", async (_request, reply) => {
    try {
      return await jobService.getStats();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/api/v1/jobs/history", async (request, reply) => {
    const parsed = JobHistoryParamsSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0].message });
    }
    try {
      return await jobService.listRunsForJob(parsed.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(404).send({ error: message });
    }
  });

  // ---------------------------------------------------------------------------
  // MCP routes
  // ---------------------------------------------------------------------------

  app.post("/api/mcp", async (request, reply) => {
    reply.hijack();
    await handleMcpRequest(request.raw, reply.raw, request.body);
  });

  app.post("/api/mcp/jobs/:runId/:agentId", async (request, reply) => {
    const params = request.params as { runId?: string; agentId?: string };
    const runId = params.runId ?? "";
    const agentId = params.agentId ?? "";
    const agent = await agentManager.getAgent(agentId);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    const run = await jobService.getActiveRunForAgent(agentId);
    if (!run || run.id !== runId || run.agentId !== agentId) {
      return reply.code(404).send({ error: "Active job run not found for agent." });
    }

    let repoRoot: string | null = null;
    let worktreeRoot: string | null = null;
    try {
      repoRoot = await resolveRepoRoot(agent.cwd);
      worktreeRoot = await resolveWorktreeRoot(agent.cwd);
    } catch {
      // Agent may not be in a git repository — MCP still works, just without repo context.
    }

    reply.hijack();
    await handleMcpRequest(request.raw, reply.raw, request.body, {
      agent,
      repoRoot,
      worktreeRoot,
      toolScope: "job",
      jobTools: {
        complete: mcpJobComplete,
        failed: mcpJobFailed,
        needsInput: mcpJobNeedsInput,
        log: mcpJobLog,
        listAgents: async () => {
          const agents = await agentManager.listAgents();
          return agents.map((a) => ({ id: a.id, name: a.name, status: a.status, cwd: a.cwd }));
        },
        listRecentPersonaReviews: (sinceDays: number) => agentManager.listRecentPersonaReviews(sinceDays),
        listRecentFeedback: (sinceDays: number) => agentManager.listRecentFeedback(sinceDays),
      },
    });
  });

  app.post("/api/mcp/:agentId", async (request, reply) => {
    const params = request.params as { agentId?: string };
    const agentId = params.agentId ?? "";
    const agent = await agentManager.getAgent(agentId);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    const activeJobRun = await jobService.getActiveRunForAgent(agentId);
    if (activeJobRun) {
      return reply.code(403).send({ error: "Job agents must use the job-scoped MCP route." });
    }

    let repoRoot: string | null = null;
    let worktreeRoot: string | null = null;
    try {
      repoRoot = await resolveRepoRoot(agent.cwd);
      worktreeRoot = await resolveWorktreeRoot(agent.cwd);
    } catch {
      // Agent may not be in a git repository — MCP still works, just without repo context.
    }

    reply.hijack();
    await handleMcpRequest(request.raw, reply.raw, request.body, {
      agent: {
        id: agent.id,
        cwd: agent.cwd,
        persona: agent.persona,
        parentAgentId: agent.parentAgentId,
      },
      repoRoot,
      worktreeRoot,
      upsertEvent: mcpUpsertEvent,
      shareMedia: mcpShareMedia,
      submitFeedback: mcpSubmitFeedback,
      launchPersona: mcpLaunchPersona,
      getFeedback: mcpGetFeedback,
      resolveFeedback: mcpResolveFeedback,
      upsertPin: mcpUpsertPin,
      deletePin: mcpDeletePin,
      getParentContext: mcpGetParentContext,
      updateReviewStatus: mcpUpdateReviewStatus,
      completeReview: mcpCompleteReview,
    });
  });

  app.get("/api/mcp", async (_, reply) => {
    return reply.code(405).send(mcpMethodNotAllowed());
  });

  app.delete("/api/mcp", async (_, reply) => {
    return reply.code(405).send(mcpMethodNotAllowed());
  });

  app.get("/api/mcp/:agentId", async (_, reply) => {
    return reply.code(405).send(mcpMethodNotAllowed());
  });

  app.delete("/api/mcp/:agentId", async (_, reply) => {
    return reply.code(405).send(mcpMethodNotAllowed());
  });

  // --- Branding (public, no auth required) ---

  app.get("/api/v1/app/branding", async () => {
    return { iconColor: cachedIconColor };
  });

  // --- Release routes ---

  app.get("/api/v1/app/version", async () => {
    return getAppVersionInfo();
  });

  app.get("/api/v1/release/status", async () => {
    const record = await readReleaseStore();
    return { tag: record?.tag ?? null, deployedAt: record?.deployedAt ?? null };
  });

  app.get("/api/v1/release/info", async (_, reply) => {
    try {
      await runCommand("git", ["-C", serverDir, "fetch", "origin", "--tags", "--quiet"]);

      // Current deployed tag from store (fast)
      const record = await readReleaseStore();
      const currentTag = record?.tag ?? null;

      // Check admin permissions (cached for process lifetime)
      const isAdmin = await checkIsAdmin();

      // Find latest tag from origin
      const tagsResult = await runCommand("git", ["-C", serverDir, "tag", "--sort=-version:refname"]);
      const latestTag = tagsResult.stdout.split("\n").find((t) => t.startsWith("v")) ?? null;

      const updateAvailable = !!(currentTag && latestTag && compareSemver(latestTag, currentTag) > 0);

      // Try to enrich with GitHub Release metadata
      let latestRelease: { tag: string; publishedAt: string; url: string } | null = null;
      if (latestTag && updateAvailable) {
        latestRelease = await fetchLatestReleaseMetadata(latestTag);
      }

      // Admin-only: unreleased commits on main
      let unreleasedCount = 0;
      let commits: Array<{ sha: string; subject: string }> = [];
      let refMissing = false;

      // Compare latest release tag to main to find truly unreleased commits.
      // Using latestTag (not currentTag) ensures that instances running an
      // older version don't show already-released commits as "unreleased".
      const compareTag = latestTag ?? currentTag;
      if (isAdmin && compareTag) {
        const refCheck = await runCommand(
          "git", ["-C", serverDir, "rev-parse", "--verify", compareTag],
          { allowedExitCodes: [0, 128] }
        );
        if (refCheck.exitCode !== 0) {
          refMissing = true;
        } else {
          const countResult = await runCommand("git", [
            "-C", serverDir,
            "rev-list", `${compareTag}..origin/main`, "--count"
          ]);
          unreleasedCount = Number(countResult.stdout) || 0;

          if (unreleasedCount > 0) {
            const logResult = await runCommand("git", [
              "-C", serverDir,
              "log", `${compareTag}..origin/main`,
              "--no-merges",
              "--format=%H\t%s",
              "--max-count=20"
            ]);
            commits = logResult.stdout
              .split("\n")
              .filter((l) => l.trim())
              .map((line) => {
                const tab = line.indexOf("\t");
                return {
                  sha: line.slice(0, tab).slice(0, 7),
                  subject: line.slice(tab + 1)
                };
              });
          }
        }
      }

      return {
        currentTag,
        isAdmin,
        latestTag,
        updateAvailable,
        latestRelease,
        unreleasedCount,
        commits,
        refMissing
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return reply.code(500).send({ error: message });
    }
  });

  app.post("/api/v1/release", async (request, reply) => {
    const body = request.body as { versionType?: unknown } | undefined;

    if (!body?.versionType || !RELEASE_VERSION_TYPES.includes(body.versionType as ReleaseVersionType)) {
      return reply.code(400).send({ error: `versionType must be one of: ${RELEASE_VERSION_TYPES.join(", ")}` });
    }

    const versionType = body.versionType as ReleaseVersionType;

    // Only one release at a time
    if (activeReleaseJob && activeReleaseJob.phase !== "done" && activeReleaseJob.phase !== "failed") {
      return reply.code(409).send({ error: "A release is already in progress." });
    }

    // Quick pre-flight: check gh CLI before spawning the job
    try {
      await runCommand("gh", ["--version"]);
    } catch {
      return reply.code(422).send({ error: "GitHub CLI (gh) is not available. Install it from https://cli.github.com" });
    }

    const job: ReleaseJob = {
      jobType: "create",
      versionType,
      phase: "preflight",
      startedAt: new Date().toISOString(),
      log: [],
      runUrl: null,
      tag: null,
      error: null
    };
    activeReleaseJob = job;

    // Run async — do not await
    void runReleaseJob(job);

    return reply.code(202).send({ ok: true });
  });

  app.post("/api/v1/release/update", async (request, reply) => {
    const body = request.body as { tag?: unknown } | undefined;

    if (!body?.tag || typeof body.tag !== "string" || !body.tag.startsWith("v")) {
      return reply.code(400).send({ error: "tag is required and must be a version tag (e.g. v0.2.31)" });
    }

    const tag = body.tag as string;

    // Only one release/update at a time
    if (activeReleaseJob && activeReleaseJob.phase !== "done" && activeReleaseJob.phase !== "failed") {
      return reply.code(409).send({ error: "A release or update is already in progress." });
    }

    const job: ReleaseJob = {
      jobType: "update",
      versionType: null,
      phase: "fetching",
      startedAt: new Date().toISOString(),
      log: [],
      runUrl: null,
      tag,
      error: null
    };
    activeReleaseJob = job;

    // Run async — do not await
    void runUpdateJob(job);

    return reply.code(202).send({ ok: true });
  });

  app.get("/api/v1/release/stream", async (_request, reply) => {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.hijack();

    const stream = reply.raw;
    releaseStreamClients.add(stream);

    const heartbeat = setInterval(() => {
      stream.write(": keepalive\n\n");
    }, 20_000);

    // Send current job snapshot
    const snapshot: ReleaseStreamEvent = { type: "snapshot", job: activeReleaseJob };
    stream.write(`data: ${JSON.stringify(snapshot)}\n\n`);

    stream.on("close", () => {
      clearInterval(heartbeat);
      releaseStreamClients.delete(stream);
    });
  });

  // --- Health / existing routes ---

  app.get("/api/v1/health", async () => {
    const result = await pool.query("SELECT NOW() AS now");

    return {
      status: "ok",
      db: "ok",
      now: result.rows[0]?.now
    };
  });

  // Write an image from the browser clipboard to the host's system clipboard.
  // This bridges remote browser sessions to the local system clipboard so that
  // CLI tools (e.g. Claude CLI) can read pasted images via native APIs.
  app.post("/api/v1/clipboard/image", async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ error: "An image file field is required." });
    }
    const mime = data.mimetype;
    if (!mime.startsWith("image/")) {
      return reply.code(400).send({ error: "Only image files are accepted." });
    }

    const buffer = await data.toBuffer();
    const ext = mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : "png";
    const tmpPath = `/tmp/dispatch-clipboard-${Date.now()}.${ext}`;
    await writeFile(tmpPath, buffer);

    try {
      if (os.platform() === "darwin") {
        const pasteboardClass = ext === "jpg" ? "JPEG" : "PNGf";
        await new Promise<void>((resolve, reject) => {
          const proc = spawn("osascript", [
            "-e",
            `set the clipboard to (read (POSIX file "${tmpPath}") as «class ${pasteboardClass}»)`
          ]);
          proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`osascript exited ${code}`)));
          proc.on("error", reject);
        });
      } else {
        const display = process.env.DISPATCH_COPY_DISPLAY;
        if (!display) {
          return reply.code(500).send({ error: "DISPATCH_COPY_DISPLAY is not set. Clipboard image paste on Linux requires Xvfb and xclip." });
        }
        await new Promise<void>((resolve, reject) => {
          const proc = spawn("xclip", ["-selection", "clipboard", "-t", mime, "-i", tmpPath], {
            env: { ...process.env, DISPLAY: display }
          });
          proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`xclip exited ${code}`)));
          proc.on("error", reject);
        });
      }
      return reply.code(200).send({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: `Failed to write to clipboard: ${message}` });
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  });

  app.get("/api/v1/system/defaults", async () => {
    return {
      homeDir: os.homedir()
    };
  });

  function resolveTildePath(raw: string): string {
    if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
    if (raw === "~") return os.homedir();
    return raw;
  }

  app.get("/api/v1/system/path-info", async (request, reply) => {
    const query = request.query as { path?: unknown };
    if (typeof query?.path !== "string" || !query.path.trim()) {
      return reply.code(400).send({ error: "path query parameter is required." });
    }
    const resolved = resolveTildePath(query.path.trim());
    if (!path.isAbsolute(resolved)) {
      return { exists: false, isDirectory: false, isGitRepo: false, resolvedPath: resolved };
    }
    try {
      const info = await stat(resolved).catch(() => null);
      const exists = info !== null;
      const isDirectory = exists && info.isDirectory();
      let isGitRepo = false;
      if (isDirectory) {
        const result = await runCommand("git", ["-C", resolved, "rev-parse", "--is-inside-work-tree"], {
          timeoutMs: 3_000,
          allowedExitCodes: [0, 1, 128],
        });
        isGitRepo = result.exitCode === 0 && result.stdout.trim() === "true";
      }
      return { exists, isDirectory, isGitRepo, resolvedPath: resolved };
    } catch {
      return { exists: false, isDirectory: false, isGitRepo: false, resolvedPath: resolved };
    }
  });

  app.get("/api/v1/system/path-completions", async (request, reply) => {
    const query = request.query as { prefix?: unknown };
    if (typeof query?.prefix !== "string" || !query.prefix.trim()) {
      return reply.code(400).send({ error: "prefix query parameter is required." });
    }
    const raw = query.prefix.trim();
    const resolved = resolveTildePath(raw);
    if (!path.isAbsolute(resolved)) {
      return { completions: [] };
    }
    try {
      const parentDir = path.dirname(resolved);
      const partial = path.basename(resolved).toLowerCase();

      // If the prefix ends with /, list children of that directory instead
      const isExactDir = raw.endsWith("/");
      const searchDir = isExactDir ? resolved : parentDir;
      const searchPartial = isExactDir ? "" : partial;

      const entries = await readdir(searchDir, { withFileTypes: true });
      const dirs = entries
        .filter((entry) => {
          if (!entry.isDirectory()) return false;
          // Skip hidden dirs unless the partial starts with "."
          if (entry.name.startsWith(".") && !searchPartial.startsWith(".")) return false;
          return entry.name.toLowerCase().startsWith(searchPartial);
        })
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 20)
        .map((entry) => path.join(searchDir, entry.name));

      // Convert back to tilde paths if the input used tilde
      const homeDir = os.homedir();
      const completions = dirs.map((dir) =>
        raw.startsWith("~") && dir.startsWith(homeDir)
          ? "~" + dir.slice(homeDir.length)
          : dir
      );

      return { completions };
    } catch {
      return { completions: [] };
    }
  });

  // --- Git helpers ---
  app.get("/api/v1/git/branches", async (request, reply) => {
    const query = request.query as { cwd?: unknown };
    if (typeof query?.cwd !== "string" || !query.cwd.trim()) {
      return reply.code(400).send({ error: "cwd query parameter is required." });
    }
    try {
      const rawCwd = query.cwd.trim();
      const cwd = rawCwd.startsWith("~/") ? path.join(os.homedir(), rawCwd.slice(2)) : rawCwd === "~" ? os.homedir() : rawCwd;
      const result = await runCommand("git", ["-C", cwd, "ls-remote", "--heads", "origin"], {
        timeoutMs: 15_000,
      });
      if (result.exitCode !== 0) {
        return reply.code(500).send({ error: "Failed to list remote branches." });
      }
      const branches = result.stdout
        .split("\n")
        .map((line) => line.replace(/^.*refs\/heads\//, "").trim())
        .filter(Boolean)
        .sort((a, b) => {
          if (a === "main") return -1;
          if (b === "main") return 1;
          if (a === "master") return -1;
          if (b === "master") return 1;
          return a.localeCompare(b);
        });
      return { branches };
    } catch {
      return reply.code(500).send({ error: "Failed to list remote branches." });
    }
  });

  // --- Agent worktree settings ---
  const WORKTREE_LOCATION_KEY = "worktree_location";
  const INSTANCE_NAME_KEY = "instance_name";
  type WorktreeLocation = "sibling" | "nested";
  const VALID_WORKTREE_LOCATIONS: WorktreeLocation[] = ["sibling", "nested"];

  app.get("/api/v1/agents/settings", async () => {
    const raw = await getSetting(pool, WORKTREE_LOCATION_KEY);
    const worktreeLocation: WorktreeLocation =
      raw && (VALID_WORKTREE_LOCATIONS as string[]).includes(raw) ? (raw as WorktreeLocation) : "sibling";
    const instanceName = (await getSetting(pool, INSTANCE_NAME_KEY)) ?? "";
    return { worktreeLocation, iconColor: cachedIconColor, instanceName };
  });

  app.post("/api/v1/agents/settings", async (request, reply) => {
    const body = request.body as { worktreeLocation?: unknown; iconColor?: unknown; instanceName?: unknown };

    if (body.worktreeLocation !== undefined) {
      if (typeof body.worktreeLocation !== "string" || !(VALID_WORKTREE_LOCATIONS as string[]).includes(body.worktreeLocation)) {
        return reply.code(400).send({ error: `worktreeLocation must be "sibling" or "nested".` });
      }
      await setSetting(pool, WORKTREE_LOCATION_KEY, body.worktreeLocation);
    }

    if (body.iconColor !== undefined) {
      if (typeof body.iconColor !== "string" || !(VALID_ICON_COLORS as readonly string[]).includes(body.iconColor)) {
        return reply.code(400).send({ error: `iconColor must be one of: ${VALID_ICON_COLORS.join(", ")}` });
      }
      await setSetting(pool, ICON_COLOR_KEY, body.iconColor);
      rewriteForColor(body.iconColor as IconColor);
    }

    if (body.instanceName !== undefined) {
      if (typeof body.instanceName !== "string") {
        return reply.code(400).send({ error: "instanceName must be a string." });
      }
      const trimmed = body.instanceName.trim().slice(0, 100);
      if (trimmed) {
        await setSetting(pool, INSTANCE_NAME_KEY, trimmed);
      } else {
        await deleteSetting(pool, INSTANCE_NAME_KEY);
      }
    }

    const raw = await getSetting(pool, WORKTREE_LOCATION_KEY);
    const worktreeLocation: WorktreeLocation =
      raw && (VALID_WORKTREE_LOCATIONS as string[]).includes(raw) ? (raw as WorktreeLocation) : "sibling";
    const instanceName = (await getSetting(pool, INSTANCE_NAME_KEY)) ?? "";
    return { worktreeLocation, iconColor: cachedIconColor, instanceName };
  });

  // --- Notification settings ---
  app.get("/api/v1/notifications/settings", async () => {
    return slackNotifier.getSettings();
  });

  app.post("/api/v1/notifications/settings", async (request, reply) => {
    const body = request.body as {
      webhookUrl?: unknown;
      notifyEvents?: unknown;
    } | null;

    if (body?.webhookUrl !== undefined) {
      if (typeof body.webhookUrl !== "string") {
        return reply.code(400).send({ error: "webhookUrl must be a string." });
      }
      await slackNotifier.setWebhookUrl(body.webhookUrl);
    }

    if (body?.notifyEvents !== undefined) {
      if (!Array.isArray(body.notifyEvents)) {
        return reply.code(400).send({ error: "notifyEvents must be an array." });
      }
      await slackNotifier.setNotifyEvents(body.notifyEvents as string[]);
    }

    return slackNotifier.getSettings();
  });

  app.post("/api/v1/notifications/test", async (request, reply) => {
    const body = request.body as { webhookUrl?: unknown } | null;
    const url = typeof body?.webhookUrl === "string" ? body.webhookUrl : await slackNotifier.getWebhookUrl();
    if (!url) {
      return reply.code(400).send({ error: "No webhook URL provided or configured." });
    }
    return slackNotifier.sendTestMessage(url);
  });

  app.get("/api/v1/app/settings/agent-types", async () => {
    return {
      enabledAgentTypes: await getEnabledAgentTypes(pool)
    };
  });

  app.post("/api/v1/app/settings/agent-types", async (request, reply) => {
    const body = request.body as { enabledAgentTypes?: unknown } | null;

    if (!Array.isArray(body?.enabledAgentTypes)) {
      return reply.code(400).send({ error: "enabledAgentTypes must be an array." });
    }

    const uniqueTypes = body.enabledAgentTypes
      .filter((value): value is typeof AGENT_TYPES[number] => typeof value === "string" && AGENT_TYPES.includes(value as typeof AGENT_TYPES[number]))
      .filter((value, index, values) => values.indexOf(value) === index);

    if (uniqueTypes.length === 0) {
      return reply.code(400).send({ error: "At least one agent type must remain enabled." });
    }

    if (uniqueTypes.length !== body.enabledAgentTypes.length) {
      return reply
        .code(400)
        .send({ error: `enabledAgentTypes must only include ${AGENT_TYPES.join(", ")}.` });
    }

    return {
      enabledAgentTypes: await setEnabledAgentTypes(pool, uniqueTypes)
    };
  });

  // --- Energy metrics beacon (PWA diagnostics) ---
  app.post("/api/v1/energy-report", async (request, reply) => {
    try {
      const metrics = request.body;
      app.log.info({ energyMetrics: metrics }, "PWA energy metrics report");
    } catch {
      // Beacon payloads are fire-and-forget; don't fail loudly
    }
    return reply.status(204).send();
  });

  app.get("/api/v1/diagnostics/git-context", async () => {
    const now = Date.now();
    const pendingAges = Array.from(pendingGitRefreshEnqueuedAt.values()).map((queuedAt) =>
      Math.max(0, now - queuedAt)
    );
    const oldestPendingAgeMs = pendingAges.length > 0 ? Math.max(...pendingAges) : null;

    const durations = [...gitRefreshDurationsMs].sort((a, b) => a - b);
    const p50DurationMs = percentile(durations, 0.5);
    const p95DurationMs = percentile(durations, 0.95);
    const maxDurationMs = durations.length > 0 ? durations[durations.length - 1] : null;
    const lastDurationMs =
      gitRefreshDurationsMs.length > 0 ? gitRefreshDurationsMs[gitRefreshDurationsMs.length - 1] : null;

    const agents = Array.from(gitRefreshAgentDiagnostics.entries())
      .map(([agentId, diag]) => ({
        agentId,
        pending: pendingGitRefreshAgentIds.has(agentId),
        active: activeGitRefreshAgentIds.has(agentId),
        lastQueuedAt: toIso(diag.lastQueuedAt),
        lastStartedAt: toIso(diag.lastStartedAt),
        lastCompletedAt: toIso(diag.lastCompletedAt),
        lastDurationMs: diag.lastDurationMs,
        lastResult: diag.lastResult,
        lastError: diag.lastError
      }))
      .sort((a, b) => a.agentId.localeCompare(b.agentId));

    return {
      config: {
        intervalMs: GIT_CONTEXT_REFRESH_INTERVAL_MS,
        concurrency: GIT_CONTEXT_REFRESH_CONCURRENCY,
        probeTimeoutMs: PROBE_COMMAND_TIMEOUT_MS
      },
      queue: {
        pending: pendingGitRefreshAgentIds.size,
        active: activeGitRefreshAgentIds.size,
        oldestPendingAgeMs
      },
      counters: gitRefreshCounters,
      durationsMs: {
        samples: durations.length,
        p50: p50DurationMs,
        p95: p95DurationMs,
        max: maxDurationMs,
        last: lastDurationMs
      },
      agents
    };
  });

  // ── Activity tracking ──────────────────────────────────────────────

  app.get("/api/v1/activity/heatmap", async (request) => {
    const query = request.query as Record<string, unknown>;
    const days = Math.min(Math.max(parseInt((query.days as string) ?? "365", 10) || 365, 1), 730);
    const rawTz = typeof query.tz === "string" && query.tz ? query.tz : FALLBACK_TZ;
    const tz = VALID_TIMEZONES.has(rawTz) ? rawTz : FALLBACK_TZ;

    const result = await pool.query<{ day: string; count: number }>(
      `SELECT ${dateTruncTz("day", "created_at", tz)} AS day, COUNT(*)::int AS count
       FROM agent_events
       WHERE created_at >= NOW() - make_interval(days => $1)
       GROUP BY day ORDER BY day`,
      [days]
    );

    return { days: result.rows };
  });

  app.get("/api/v1/activity/stats", async (request) => {
    const aq = parseActivityQuery(request.query as Record<string, unknown>);
    const { rows, rangeStart } = await loadScopedActivityEvents(aq);
    const eventFilter = timeRangeClause(aq, "created_at");

    const busiestDayResult = await pool.query<{ day: string; count: number }>(
      `SELECT ${dateTruncTz("day", "created_at", aq.tz)} AS day, COUNT(*)::int AS count
       FROM agent_events
       ${eventFilter.clause}
      GROUP BY day ORDER BY count DESC LIMIT 1`,
      eventFilter.params
    );
    const stats = computeActivityStats(rows, rangeStart);

    return {
      totalWorkingMs: stats.totalWorkingMs,
      avgBlockedMs: stats.avgBlockedMs,
      avgWaitingMs: stats.avgWaitingMs,
      busiestDay: busiestDayResult.rows[0]?.day ?? null,
      busiestDayCount: busiestDayResult.rows[0]?.count ?? 0,
      stateDurations: stats.stateDurations,
    };
  });

  app.get("/api/v1/activity/daily-status", async (request) => {
    const aq = parseActivityQuery(request.query as Record<string, unknown>);
    const { rows, rangeStart } = await loadScopedActivityEvents(aq);
    const dailyStatus = computeDailyStatus(rows, rangeStart, aq.granularity);

    return { days: dailyStatus, granularity: aq.granularity };
  });

  app.get("/api/v1/activity/active-hours", async (request) => {
    const aq = parseActivityQuery(request.query as Record<string, unknown>);
    const eventFilter = timeRangeClause(aq, "created_at");
    const result = await pool.query<{ created_at: string }>(
      `SELECT created_at::text AS created_at
       FROM agent_events
       ${eventFilter.clause ? `${eventFilter.clause} AND` : "WHERE"} event_type IN ('working', 'blocked', 'waiting_user')
       ORDER BY created_at`,
      eventFilter.params
    );

    return { events: result.rows };
  });

  app.get("/api/v1/activity/agents-created", async (request) => {
    const aq = parseActivityQuery(request.query as Record<string, unknown>);
    const eventFilter = timeRangeClause(aq, "first_seen");
    const result = await pool.query<{ day: string; count: number }>(
      `SELECT ${dateTruncTz(aq.granularity, "first_seen", aq.tz)} AS day, COUNT(*)::int AS count
       FROM (
         SELECT agent_id, MIN(created_at) AS first_seen
         FROM agent_events
         GROUP BY agent_id
       ) per_agent
       ${eventFilter.clause}
       GROUP BY day ORDER BY day`,
      eventFilter.params
    );
    const total = result.rows.reduce((sum, r) => sum + r.count, 0);
    return { days: result.rows, total, granularity: aq.granularity };
  });

  app.get("/api/v1/activity/working-time-by-project", async (request) => {
    const aq = parseActivityQuery(request.query as Record<string, unknown>);
    const rangeStart = aq.start;
    const eventFilter = timeRangeClause(aq, "ae.created_at");

    const inRangeResult = await pool.query<ActivityEventRow>(
      `SELECT ae.agent_id, ae.event_type, ae.created_at,
              COALESCE(ae.project_dir, a.cwd) AS project_dir
       FROM agent_events ae
       LEFT JOIN agents a ON a.id = ae.agent_id
       ${eventFilter.clause}
       ORDER BY ae.agent_id, ae.created_at`,
      eventFilter.params
    );

    let rows = inRangeResult.rows;
    if (rangeStart) {
      const boundaryResult = await pool.query<ActivityEventRow>(
        `SELECT DISTINCT ON (ae.agent_id) ae.agent_id, ae.event_type, ae.created_at,
                COALESCE(ae.project_dir, a.cwd) AS project_dir
         FROM agent_events ae
         LEFT JOIN agents a ON a.id = ae.agent_id
         WHERE ae.created_at < $1
         ORDER BY ae.agent_id, ae.created_at DESC`,
        [rangeStart]
      );
      rows = [...boundaryResult.rows, ...inRangeResult.rows].sort((a, b) => {
        const agentCompare = a.agent_id.localeCompare(b.agent_id);
        if (agentCompare !== 0) return agentCompare;
        return a.created_at.getTime() - b.created_at.getTime();
      });
    }

    const projects = computeWorkingTimeByProject(rows, rangeStart);
    return { projects };
  });

  // ── Token usage ──────────────────────────────────────────────────

  app.get("/api/v1/activity/token-stats", async (request) => {
    const aq = parseActivityQuery(request.query as Record<string, unknown>);
    const tokenFilter = timeRangeClause(aq, "COALESCE(session_start, harvested_at)");
    const result = await pool.query<{
      total_input: number;
      total_cache_creation: number;
      total_cache_read: number;
      total_output: number;
      total_messages: number;
      total_sessions: number;
    }>(
      `SELECT
        COALESCE(SUM(input_tokens), 0) AS total_input,
        COALESCE(SUM(cache_creation_tokens), 0) AS total_cache_creation,
        COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read,
        COALESCE(SUM(output_tokens), 0) AS total_output,
        COALESCE(SUM(message_count), 0) AS total_messages,
        COUNT(DISTINCT session_id) AS total_sessions
       FROM agent_token_usage
       ${tokenFilter.clause}`,
      tokenFilter.params
    );
    return result.rows[0] ?? {
      total_input: 0,
      total_cache_creation: 0,
      total_cache_read: 0,
      total_output: 0,
      total_messages: 0,
      total_sessions: 0,
    };
  });

  app.get("/api/v1/activity/token-daily", async (request) => {
    const aq = parseActivityQuery(request.query as Record<string, unknown>);
    const tokenFilter = timeRangeClause(aq, "COALESCE(session_start, harvested_at)");

    const result = await pool.query<{
      day: string;
      input_tokens: number;
      cache_creation_tokens: number;
      cache_read_tokens: number;
      output_tokens: number;
      messages: number;
    }>(
      `SELECT
        ${dateTruncTz(aq.granularity, "COALESCE(session_start, harvested_at)", aq.tz)} AS day,
        SUM(input_tokens) AS input_tokens,
        SUM(cache_creation_tokens) AS cache_creation_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(message_count) AS messages
       FROM agent_token_usage
       ${tokenFilter.clause}
       GROUP BY day ORDER BY day`,
      tokenFilter.params
    );
    return { days: result.rows, granularity: aq.granularity };
  });

  app.get("/api/v1/activity/token-by-project", async (request) => {
    const aq = parseActivityQuery(request.query as Record<string, unknown>);
    const tokenFilter = timeRangeClause(aq, "COALESCE(t.session_start, t.harvested_at)");
    const result = await pool.query<{
      project_dir: string;
      total_input: number;
      total_output: number;
      messages: number;
    }>(
      `SELECT
        COALESCE(a.git_context->>'repoRoot', a.cwd) AS project_dir,
        SUM(t.input_tokens + t.cache_creation_tokens + t.cache_read_tokens) AS total_input,
        SUM(t.output_tokens) AS total_output,
        SUM(t.message_count) AS messages
       FROM agent_token_usage t
       JOIN agents a ON a.id = t.agent_id
       ${tokenFilter.clause}
       GROUP BY project_dir
       ORDER BY total_input DESC
       LIMIT 20`,
      tokenFilter.params
    );
    return { projects: result.rows };
  });

  app.get("/api/v1/activity/token-by-model", async (request) => {
    const aq = parseActivityQuery(request.query as Record<string, unknown>);
    const tokenFilter = timeRangeClause(aq, "COALESCE(session_start, harvested_at)");
    const result = await pool.query<{
      model: string;
      total_input: number;
      total_cache_creation: number;
      total_cache_read: number;
      total_output: number;
      sessions: number;
    }>(
      `SELECT
        model,
        COALESCE(SUM(input_tokens), 0) AS total_input,
        COALESCE(SUM(cache_creation_tokens), 0) AS total_cache_creation,
        COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read,
        COALESCE(SUM(output_tokens), 0) AS total_output,
       COUNT(DISTINCT session_id) AS sessions
       FROM agent_token_usage
       ${tokenFilter.clause}
       GROUP BY model
       ORDER BY (SUM(input_tokens) + SUM(cache_creation_tokens) + SUM(cache_read_tokens) + SUM(output_tokens)) DESC`,
      tokenFilter.params
    );
    return { models: result.rows };
  });

  app.post("/api/v1/agents/:id/harvest-tokens", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = await agentManager.getAgent(id);
    if (!agent) return reply.code(404).send({ error: "Agent not found" });

    await agentManager.harvestAgentTokens(agent);

    return { ok: true };
  });

  // ── Agent History ─────────────────────────────────────────────────

  app.get("/api/v1/history/projects", async () => {
    const result = await pool.query<{ project: string }>(
      `SELECT DISTINCT COALESCE(git_context->>'repoRoot', cwd) AS project
       FROM agents
       WHERE COALESCE(git_context->>'repoRoot', cwd) IS NOT NULL
       ORDER BY project`
    );
    return { projects: result.rows.map((r) => r.project) };
  });

  app.get("/api/v1/history/agents", async (request) => {
    const query = request.query as Record<string, unknown>;
    const aq = parseActivityQuery(query);
    const limit = Math.min(Math.max(parseInt(String(query.limit ?? "50"), 10) || 50, 1), 100);
    const offset = Math.max(parseInt(String(query.offset ?? "0"), 10) || 0, 0);
    const search = typeof query.search === "string" ? query.search.trim() : "";
    const type = typeof query.type === "string" ? query.type : "";
    const project = typeof query.project === "string" ? query.project : "";
    const sortCol = typeof query.sort === "string" && ["created_at", "name", "updated_at"].includes(query.sort)
      ? query.sort
      : "created_at";
    const order = typeof query.order === "string" && query.order === "asc" ? "ASC" : "DESC";

    const conditions: string[] = ["a.parent_agent_id IS NULL"];
    const params: unknown[] = [];

    if (search) {
      params.push(`%${escapeLike(search)}%`);
      conditions.push(`a.name ILIKE $${params.length}`);
    }
    if (type) {
      params.push(type);
      conditions.push(`a.type = $${params.length}`);
    }
    if (project) {
      params.push(project);
      conditions.push(`COALESCE(a.git_context->>'repoRoot', a.cwd) = $${params.length}`);
    }

    const dateRange = timeRangeClause(aq, "a.created_at", params.length);
    params.push(...dateRange.params);
    if (dateRange.params.length > 0) {
      // Extract conditions from the WHERE clause generated by timeRangeClause
      const rangeConditions = dateRange.clause.replace(/^WHERE\s+/i, "");
      conditions.push(rangeConditions);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sortSql = sortCol === "name" ? `a.name ${order}, a.created_at DESC` : `a.${sortCol} ${order}`;
    const listParams = [...params, limit, offset];

    const [countResult, agentsResult] = await Promise.all([
      pool.query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM agents a ${whereClause}`,
        params
      ),
      pool.query(
        `SELECT
          a.id,
          a.name,
          a.type,
          a.status,
          a.cwd,
          a.worktree_path AS "worktreePath",
          a.worktree_branch AS "worktreeBranch",
          CASE
            WHEN a.latest_event_type IS NULL OR a.latest_event_message IS NULL OR a.latest_event_updated_at IS NULL THEN NULL
            ELSE json_build_object(
              'type', a.latest_event_type,
              'message', a.latest_event_message,
              'updatedAt', a.latest_event_updated_at,
              'metadata', COALESCE(a.latest_event_metadata, '{}'::jsonb)
            )
          END AS "latestEvent",
          a.git_context AS "gitContext",
          a.created_at AS "createdAt",
          a.updated_at AS "updatedAt",
          EXTRACT(EPOCH FROM (a.updated_at - a.created_at))::int * 1000 AS "durationMs",
          COALESCE((
            SELECT SUM(input_tokens + cache_creation_tokens + cache_read_tokens + output_tokens)
            FROM agent_token_usage WHERE agent_id = a.id
          ), 0)::bigint AS "totalTokens"
         FROM agents a
         ${whereClause}
         ORDER BY ${sortSql}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        listParams
      ),
    ]);

    const parentIds = agentsResult.rows.map((a: { id: string }) => a.id);

    // Fetch child (persona/review) agents for these parents
    type ChildAgent = {
      id: string;
      name: string;
      persona: string | null;
      status: string;
      totalTokens: number;
      createdAt: string;
    };
    const childrenByParent = new Map<string, ChildAgent[]>();

    if (parentIds.length > 0) {
      const childResult = await pool.query<ChildAgent & { parentAgentId: string }>(
        `SELECT
          a.id,
          a.name,
          a.persona,
          a.status,
          COALESCE((
            SELECT SUM(input_tokens + cache_creation_tokens + cache_read_tokens + output_tokens)
            FROM agent_token_usage WHERE agent_id = a.id
          ), 0)::bigint AS "totalTokens",
          a.created_at AS "createdAt",
          a.parent_agent_id AS "parentAgentId"
         FROM agents a
         WHERE a.parent_agent_id = ANY($1)
         ORDER BY a.created_at ASC`,
        [parentIds]
      );
      for (const child of childResult.rows) {
        const pid = child.parentAgentId;
        let list = childrenByParent.get(pid);
        if (!list) { list = []; childrenByParent.set(pid, list); }
        list.push({
          id: child.id,
          name: child.name,
          persona: child.persona,
          status: child.status,
          totalTokens: child.totalTokens,
          createdAt: child.createdAt,
        });
      }
    }

    const agents = agentsResult.rows.map((agent: { id: string; totalTokens: number }) => {
      const children = childrenByParent.get(agent.id) ?? [];
      const childTokens = children.reduce((sum, c) => sum + c.totalTokens, 0);
      return {
        ...agent,
        children,
        groupTotalTokens: agent.totalTokens + childTokens,
      };
    });

    return { agents, total: countResult.rows[0]?.total ?? 0, limit, offset };
  });

  app.get("/api/v1/history/agents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const agentResult = await pool.query(
      `SELECT
        id, name, type, status, cwd,
        worktree_path AS "worktreePath",
        worktree_branch AS "worktreeBranch",
        CASE
          WHEN latest_event_type IS NULL OR latest_event_message IS NULL OR latest_event_updated_at IS NULL THEN NULL
          ELSE json_build_object(
            'type', latest_event_type,
            'message', latest_event_message,
            'updatedAt', latest_event_updated_at,
            'metadata', COALESCE(latest_event_metadata, '{}'::jsonb)
          )
        END AS "latestEvent",
        git_context AS "gitContext",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
       FROM agents WHERE id = $1`,
      [id]
    );
    if (agentResult.rows.length === 0) {
      return reply.code(404).send({ error: "Agent not found" });
    }

    const [eventsResult, tokenResult, tokenByModelResult, mediaResult, feedbackResult] = await Promise.all([
      pool.query<{ id: number; event_type: string; message: string; metadata: Record<string, unknown>; created_at: string }>(
        `SELECT id, event_type, message, metadata, created_at
         FROM agent_events WHERE agent_id = $1 ORDER BY created_at ASC`,
        [id]
      ),
      pool.query<{
        total_input: number;
        total_cache_creation: number;
        total_cache_read: number;
        total_output: number;
        total_messages: number;
      }>(
        `SELECT
          COALESCE(SUM(input_tokens), 0) AS total_input,
          COALESCE(SUM(cache_creation_tokens), 0) AS total_cache_creation,
          COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read,
          COALESCE(SUM(output_tokens), 0) AS total_output,
          COALESCE(SUM(message_count), 0) AS total_messages
         FROM agent_token_usage WHERE agent_id = $1`,
        [id]
      ),
      pool.query<{ model: string; input_tokens: number; output_tokens: number }>(
        `SELECT model,
          SUM(input_tokens + cache_creation_tokens + cache_read_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens
         FROM agent_token_usage WHERE agent_id = $1
         GROUP BY model ORDER BY (SUM(input_tokens + cache_creation_tokens + cache_read_tokens) + SUM(output_tokens)) DESC`,
        [id]
      ),
      pool.query<{ file_name: string; source: string; size_bytes: number; description: string | null; created_at: string }>(
        `SELECT file_name, source, size_bytes, description, created_at
         FROM media WHERE agent_id = $1 ORDER BY created_at`,
        [id]
      ),
      pool.query<{
        id: number;
        agentId: string;
        persona: string | null;
        severity: string;
        filePath: string | null;
        lineNumber: number | null;
        description: string;
        suggestion: string | null;
        mediaRef: string | null;
        status: string;
        createdAt: string;
      }>(
        `SELECT f.id, f.agent_id AS "agentId", a.persona, f.severity, f.file_path AS "filePath",
                f.line_number AS "lineNumber", f.description, f.suggestion, f.media_ref AS "mediaRef",
                f.status, f.created_at AS "createdAt"
         FROM agent_feedback f
         JOIN agents a ON a.id = f.agent_id
         WHERE a.parent_agent_id = $1
         ORDER BY f.created_at ASC
         LIMIT 500`,
        [id]
      ),
    ]);

    const eventRows: ActivityEventRow[] = eventsResult.rows.map((r) => ({
      agent_id: id,
      event_type: r.event_type,
      created_at: new Date(r.created_at),
    }));
    const stats = computeActivityStats(eventRows, null);

    return {
      agent: agentResult.rows[0],
      events: eventsResult.rows,
      tokenUsage: {
        ...tokenResult.rows[0],
        by_model: tokenByModelResult.rows,
      },
      media: mediaResult.rows,
      feedback: feedbackResult.rows,
      stateDurations: stats.stateDurations,
    };
  });

  // ── Agents ────────────────────────────────────────────────────────

  app.get("/api/v1/agents", async () => {
    const agents = await agentManager.listAgents();
    return { agents: agents.map(withStreamFlag) };
  });

  app.get("/api/v1/agents/git-context", async (request, reply) => {
    const query = request.query as { ids?: unknown };
    const ids =
      typeof query.ids === "string"
        ? query.ids
            .split(",")
            .map((id) => id.trim())
            .filter((id) => id.length > 0)
        : [];

    const idFilter = ids.length > 0 ? new Set(ids) : null;
    const agents = await agentManager.listAgents();
    const targets = idFilter ? agents.filter((agent) => idFilter.has(agent.id)) : agents;

    const contexts = targets.map((agent) => ({
      id: agent.id,
      gitContext: agent.gitContext
    }));

    return { contexts };
  });


  app.get("/api/v1/events", async (_request, reply) => {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.hijack();

    const stream = reply.raw;
    const unsubscribe = uiEventBroker.subscribe(stream);
    const heartbeat = setInterval(() => {
      stream.write(": keepalive\n\n");
    }, 20_000);

    try {
      const agents = await agentManager.listAgents();
      uiEventBroker.sendSnapshot(stream, agents.map(withStreamFlag));
    } catch (error) {
      app.log.warn({ err: error }, "Failed to load SSE snapshot.");
    }

    stream.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.post("/api/v1/focus", async (request, reply) => {
    const body = request.body as { agentId?: unknown };
    const agentId = body?.agentId;

    if (agentId === null || agentId === undefined) {
      // User is no longer focused on any agent — clear all focus immediately
      // so notifications resume without waiting for TTL expiry.
      focusTracker.clearAll();
      return reply.code(204).send();
    }

    if (typeof agentId !== "string" || !agentId.trim()) {
      return reply.code(400).send({ error: "agentId must be a non-empty string or null." });
    }

    focusTracker.setFocused(agentId.trim());
    return reply.code(204).send();
  });

  app.get("/api/v1/agents/:id", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const agent = await agentManager.getAgent(id);

    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    return { agent: withStreamFlag(agent) };
  });

  app.post("/api/v1/agents/:id/latest-event", async (request, reply) => {
    const params = request.params as { id?: string };
    const body = request.body as {
      type?: unknown;
      message?: unknown;
      metadata?: unknown;
    };
    const id = params.id ?? "";
    const type = body?.type;
    const message = body?.message;
    const metadata = body?.metadata;

    if (!isAgentLatestEventType(type)) {
      return reply.code(400).send({
        error: `type must be one of: ${AGENT_LATEST_EVENT_TYPES.join(", ")}.`
      });
    }

    if (typeof message !== "string" || !message.trim()) {
      return reply.code(400).send({ error: "message must be a non-empty string." });
    }

    if (
      metadata !== undefined &&
      (metadata === null || typeof metadata !== "object" || Array.isArray(metadata))
    ) {
      return reply.code(400).send({ error: "metadata must be an object when provided." });
    }

    const agent = await agentManager.upsertLatestEvent(id, {
      type,
      message: message.trim(),
      metadata: metadata as Record<string, unknown> | undefined
    });

    uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(agent) });
    return { agent };
  });

  app.get("/api/v1/agents/:id/media", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    // Include deleted agents so historical media lists still work
    const agentExists = await pool.query("SELECT 1 FROM agents WHERE id = $1", [id]);
    if (agentExists.rows.length === 0) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const files = await listMediaFiles(id);
    const seenKeys = await loadSeenMediaKeys(id, files.map(toMediaKey));
    return {
      files: files.map((file) => ({
        ...file,
        seen: seenKeys.has(toMediaKey(file))
      }))
    };
  });

  app.get("/api/v1/agents/:id/media/:file", async (request, reply) => {
    const params = request.params as { id?: string; file?: string };
    const id = params.id ?? "";

    // Look up agent including deleted ones so historical media still loads
    const agentRow = await pool.query<{ id: string; media_dir: string | null }>(
      "SELECT id, media_dir FROM agents WHERE id = $1",
      [id]
    );
    if (agentRow.rows.length === 0) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const file = params.file ?? "";
    if (!/^[A-Za-z0-9._-]+$/.test(file)) {
      return reply.code(400).send({ error: "Invalid media file name." });
    }

    const filePath = path.join(resolveMediaDir(agentRow.rows[0].id, agentRow.rows[0].media_dir), file);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      return reply.code(404).send({ error: "Media file not found." });
    }

    return reply.type(mimeType(file)).send(await readFile(filePath));
  });

  app.post("/api/v1/agents/:id/media", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const agent = await agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ error: "A file field is required." });
    }

    const fileName = path.basename(data.filename);
    if (!/^[A-Za-z0-9._-]+$/.test(fileName)) {
      return reply.code(400).send({ error: "Invalid file name." });
    }
    if (!isMediaFile(fileName)) {
      return reply.code(400).send({ error: "Unsupported file type. Use png/jpg/jpeg/gif/webp/mp4 or text files (txt/md/json/yaml/ts/py/etc)." });
    }

    const isText = isTextFile(fileName);
    const sourceField = (data.fields.source as { value?: string } | undefined)?.value ?? (isText ? "text" : "screenshot");
    const validSources = ["screenshot", "stream", "simulator", "text"];
    const source = validSources.includes(sourceField) ? sourceField : (isText ? "text" : "screenshot");
    const description = (data.fields.description as { value?: string } | undefined)?.value ?? null;
    if (!description) {
      return reply.code(400).send({ error: "A description field is required." });
    }

    const mediaDir = resolveMediaDir(agent.id, agent.mediaDir);
    await mkdir(mediaDir, { recursive: true });

    const buffer = await data.toBuffer();
    const filePath = path.join(mediaDir, fileName);
    await writeFile(filePath, buffer);

    const result = await pool.query<{ id: number; created_at: Date }>(
      `INSERT INTO media (agent_id, file_name, source, size_bytes, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [id, fileName, source, buffer.length, description]
    );

    const row = result.rows[0];
    const mediaRecord = {
      id: row.id,
      fileName,
      source,
      sizeBytes: buffer.length,
      createdAt: row.created_at.toISOString(),
      url: `/api/v1/agents/${id}/media/${encodeURIComponent(fileName)}`
    };

    uiEventBroker.publish({ type: "media.changed", agentId: id });
    return reply.code(201).send({ ok: true, media: mediaRecord });
  });

  app.post("/api/v1/agents/:id/media/seen", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const agent = await agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const body = request.body as { keys?: unknown } | undefined;
    if (!Array.isArray(body?.keys) || !body.keys.every((key) => typeof key === "string")) {
      return reply.code(400).send({ error: "keys must be an array of strings." });
    }

    const keys = Array.from(
      new Set(
        body.keys
          .map((key) => key.trim())
          .filter((key) => isValidMediaKey(key))
      )
    );

    if (keys.length === 0) {
      return { ok: true, updated: 0 };
    }

    await markSeenMediaKeys(id, keys);
    uiEventBroker.publish({ type: "media.seen", agentId: id, keys });
    return { ok: true, updated: keys.length };
  });

  app.post("/api/v1/agents/:id/stream", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const agent = await agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const body = request.body as { type?: unknown; port?: unknown; description?: unknown };
    if (body?.type === "stop") {
      const description = typeof body.description === "string" ? body.description : null;
      streamManager.stopStream(id, description);
      return { ok: true };
    }

    if (body?.type === "playwright") {
      if (typeof body.port !== "number" || !Number.isFinite(body.port) || body.port < 1) {
        return reply.code(400).send({ error: "port must be a positive number." });
      }
      if (streamManager.hasStream(id)) {
        return reply.code(409).send({ error: "Stream already active for this agent." });
      }
      try {
        await streamManager.startStream(id, body.port);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to start stream.";
        return reply.code(502).send({ error: message });
      }
      return { ok: true };
    }

    return reply.code(400).send({ error: "type must be 'playwright' or 'stop'." });
  });

  app.get("/api/v1/agents/:id/stream", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const agent = await agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }
    if (!streamManager.hasStream(id)) {
      return reply.code(404).send({ error: "No active stream for this agent." });
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "multipart/x-mixed-replace; boundary=frame",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    raw.flushHeaders();
    if (raw.socket) {
      raw.socket.setNoDelay(true);
    }

    const unsubscribe = streamManager.addViewer(id, raw);
    reply.raw.on("close", () => {
      unsubscribe();
    });
  });

  app.get("/api/v1/agents/:id/stream/viewer", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";
    const agent = await agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>${escapeHtml(agent.name)} — Live Stream</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0a0a0a;display:flex;align-items:center;justify-content:center;height:100vh;overflow:hidden}
  img{max-width:100%;max-height:100%;object-fit:contain}
  .gone{display:flex;align-items:center;justify-content:center;height:100vh;color:#666;font-family:system-ui;font-size:14px}
</style>
</head><body>
<img id="feed" src="/api/v1/agents/${escapeHtml(id)}/stream" alt="Live stream">
<script>
  const img = document.getElementById('feed');
  img.onerror = () => {
    document.body.innerHTML = '<div class="gone">Stream ended.</div>';
  };
</script>
</body></html>`;
    return reply.type("text/html").send(html);
  });

  app.post("/api/v1/agents", async (request, reply) => {
    const body = request.body as {
      name?: unknown;
      type?: unknown;
      cwd?: unknown;
      agentArgs?: unknown;
      codexArgs?: unknown;
      fullAccess?: unknown;
      useWorktree?: unknown;
      worktreeBranch?: unknown;
      baseBranch?: unknown;
      persona?: unknown;
      parentAgentId?: unknown;
      personaContext?: unknown;
    };

    if (typeof body?.cwd !== "string") {
      return reply.code(400).send({ error: "Body must include cwd as a string." });
    }

    const providedAgentArgs = body.agentArgs ?? body.codexArgs;
    const agentArgsValid =
      providedAgentArgs === undefined ||
      (Array.isArray(providedAgentArgs) && providedAgentArgs.every((item) => typeof item === "string"));

    if (!agentArgsValid) {
      return reply.code(400).send({ error: "agentArgs must be an array of strings." });
    }

    if (body.type !== undefined && body.type !== "codex" && body.type !== "claude" && body.type !== "opencode") {
      return reply.code(400).send({ error: "type must be codex, claude, or opencode when provided." });
    }

    if (body.fullAccess !== undefined && typeof body.fullAccess !== "boolean") {
      return reply.code(400).send({ error: "fullAccess must be a boolean when provided." });
    }

    if (body.useWorktree !== undefined && typeof body.useWorktree !== "boolean") {
      return reply.code(400).send({ error: "useWorktree must be a boolean when provided." });
    }

    if (body.worktreeBranch !== undefined && typeof body.worktreeBranch !== "string") {
      return reply.code(400).send({ error: "worktreeBranch must be a string when provided." });
    }

    if (body.baseBranch !== undefined && typeof body.baseBranch !== "string") {
      return reply.code(400).send({ error: "baseBranch must be a string when provided." });
    }

    const agentArgs = providedAgentArgs as string[] | undefined;
    const agentType = body.type === "claude" ? "claude" : body.type === "opencode" ? "opencode" : "codex";
    const enabledAgentTypes = await getEnabledAgentTypes(pool);
    if (!enabledAgentTypes.includes(agentType)) {
      return reply.code(400).send({ error: `${agentType} agents are disabled in settings.` });
    }

    const fullAccessArg =
      agentType === "claude"
        ? CLAUDE_FULL_ACCESS_ARG
        : agentType === "codex"
          ? CODEX_FULL_ACCESS_ARG
          : null;
    const resolvedAgentArgs =
      body.fullAccess === true && fullAccessArg
        ? Array.from(new Set([...(agentArgs ?? []), fullAccessArg]))
        : agentArgs;

    try {
      const worktreeLocationRaw = await getSetting(pool, WORKTREE_LOCATION_KEY);
      const worktreeLocation: WorktreeLocation =
        worktreeLocationRaw && (VALID_WORKTREE_LOCATIONS as string[]).includes(worktreeLocationRaw)
          ? (worktreeLocationRaw as WorktreeLocation)
          : "sibling";

      const agent = await agentManager.createAgent({
        name: typeof body.name === "string" ? body.name : undefined,
        type: agentType,
        cwd: body.cwd,
        agentArgs: resolvedAgentArgs,
        fullAccess: body.fullAccess === true,
        useWorktree: typeof body.useWorktree === "boolean" ? body.useWorktree : undefined,
        worktreeBranch: typeof body.worktreeBranch === "string" ? body.worktreeBranch : undefined,
        baseBranch: typeof body.baseBranch === "string" ? body.baseBranch : undefined,
        worktreeLocation,
        persona: typeof body.persona === "string" ? body.persona : undefined,
        parentAgentId: typeof body.parentAgentId === "string" ? body.parentAgentId : undefined,
        personaContext: typeof body.personaContext === "string" ? body.personaContext : undefined,
      });
      queueGitContextRefresh([agent.id]);
      uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(agent) });
      return reply.code(201).send({ agent });
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  // Setup script callbacks — called by the bash setup script running in tmux
  app.post("/api/v1/agents/:id/setup/phase", async (request, reply) => {
    const params = request.params as { id?: string };
    const body = request.body as { phase?: unknown };
    const id = params.id ?? "";

    const validPhases = ["worktree", "env", "deps", "session"];
    if (typeof body?.phase !== "string" || !validPhases.includes(body.phase)) {
      return reply.code(400).send({ error: "phase must be one of: worktree, env, deps, session" });
    }

    try {
      await agentManager.updateSetupPhase(id, body.phase as "worktree" | "env" | "deps" | "session");
      const agent = await agentManager.getAgent(id);
      if (agent) {
        uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(agent) });
      }
      return { ok: true };
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.post("/api/v1/agents/:id/setup/complete", async (request, reply) => {
    const params = request.params as { id?: string };
    const body = request.body as {
      effectiveCwd?: unknown;
      worktreePath?: unknown;
      worktreeBranch?: unknown;
    };
    const id = params.id ?? "";

    if (typeof body?.effectiveCwd !== "string") {
      return reply.code(400).send({ error: "effectiveCwd must be a string." });
    }

    try {
      const agent = await agentManager.completeSetup(id, {
        effectiveCwd: body.effectiveCwd,
        worktreePath: typeof body.worktreePath === "string" ? body.worktreePath : null,
        worktreeBranch: typeof body.worktreeBranch === "string" ? body.worktreeBranch : null,
      });
      queueGitContextRefresh([agent.id]);
      uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(agent) });
      return { ok: true };
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.post("/api/v1/agents/:id/start", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";

    try {
      const agent = await agentManager.startAgent(id);
      queueGitContextRefresh([agent.id]);
      uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(agent) });
      return { agent };
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.post("/api/v1/agents/:id/stop", async (request, reply) => {
    const params = request.params as { id?: string };
    const body = request.body as { force?: unknown } | undefined;
    const id = params.id ?? "";

    app.log.info({ agentId: id, force: body?.force ?? false }, "Stop agent requested");

    if (body?.force !== undefined && typeof body.force !== "boolean") {
      return reply.code(400).send({ error: "force must be a boolean when provided." });
    }

    try {
      const agent = await agentManager.stopAgent(id, { force: body?.force as boolean | undefined });
      queueGitContextRefresh([agent.id]);
      uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(agent) });
      return { agent };
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.get("/api/v1/agents/:id/worktree-status", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";

    try {
      const status = await agentManager.checkWorktreeStatus(id);
      return status;
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.delete("/api/v1/agents/:id", async (request, reply) => {
    const params = request.params as { id?: unknown };
    const query = request.query as { cleanupWorktree?: unknown };

    if (typeof params.id !== "string") {
      return reply.code(400).send({ error: "Missing agent id." });
    }

    const validCleanupModes = ["auto", "keep", "force"] as const;
    type CleanupMode = (typeof validCleanupModes)[number];
    const cleanupWorktree: CleanupMode =
      typeof query.cleanupWorktree === "string" && (validCleanupModes as readonly string[]).includes(query.cleanupWorktree)
        ? (query.cleanupWorktree as CleanupMode)
        : "auto";

    try {
      // Fast synchronous phase: mark agent as archiving and return immediately.
      // cleanupWorktree is persisted so reconciliation can honor it if the server restarts.
      const agent = await agentManager.beginArchive(params.id, cleanupWorktree);
      uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(agent) });

      // Fire-and-forget: run cleanup in background (tracked for graceful shutdown + dedup)
      const agentId = params.id;
      archivingAgentIds.add(agentId);
      const archivePromise = agentManager.executeArchive(agentId, {
        onPhaseChange: (updated) => {
          uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(updated) });
        },
        onComplete: (deletedIds) => {
          for (const deletedId of deletedIds) {
            streamManager.stopStream(deletedId);
            pendingGitRefreshAgentIds.delete(deletedId);
            pendingGitRefreshEnqueuedAt.delete(deletedId);
            activeGitRefreshAgentIds.delete(deletedId);
            gitRefreshAgentDiagnostics.delete(deletedId);
            uiEventBroker.publish({ type: "agent.deleted", agentId: deletedId });
          }
        },
        onError: (error) => {
          app.log.error({ err: error, agentId }, "Background archive failed");
        }
      });
      activeArchives.add(archivePromise);
      archivePromise.finally(() => {
        activeArchives.delete(archivePromise);
        archivingAgentIds.delete(agentId);
      });

      return reply.code(202).send({ status: "archiving" });
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  // --- Personas ---

  app.get("/api/v1/personas", async (request, reply) => {
    const query = request.query as { cwd?: unknown };
    if (typeof query.cwd !== "string") {
      return reply.code(400).send({ error: "cwd query parameter is required." });
    }
    try {
      // Try worktree root first (uncommitted persona files live here), then repo root
      let personas = await loadPersonas(await resolveWorktreeRoot(query.cwd));
      if (personas.length === 0) {
        personas = await loadPersonas(await resolveRepoRoot(query.cwd));
      }
      return { personas };
    } catch {
      return { personas: [] };
    }
  });

  // --- Feedback ---

  app.get("/api/v1/agents/:id/feedback", async (request, reply) => {
    const params = request.params as { id?: string };
    const query = request.query as { scope?: unknown };
    const id = params.id ?? "";
    try {
      if (query.scope === "children") {
        const feedback = await agentManager.listFeedbackByParent(id);
        return { feedback };
      }
      const agent = await agentManager.getAgent(id);
      if (!agent) return reply.code(404).send({ error: "Agent not found." });
      const feedback = await agentManager.listFeedback(id);
      return { feedback };
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.patch("/api/v1/agents/:id/feedback/:feedbackId", async (request, reply) => {
    const params = request.params as { id?: string; feedbackId?: string };
    const body = request.body as { status?: unknown };
    const feedbackId = parseInt(params.feedbackId ?? "", 10);

    if (isNaN(feedbackId)) {
      return reply.code(400).send({ error: "Invalid feedback id." });
    }

    const validStatuses = ["open", "dismissed", "forwarded", "fixed", "ignored"] as const;
    if (typeof body?.status !== "string" || !(validStatuses as readonly string[]).includes(body.status)) {
      return reply.code(400).send({ error: "status must be one of: open, dismissed, forwarded, fixed, ignored" });
    }

    try {
      const agentId = params.id ?? "";
      const updated = await agentManager.updateFeedbackStatus(
        feedbackId,
        agentId,
        body.status as "open" | "dismissed" | "forwarded" | "fixed" | "ignored"
      );
      if (!updated) return reply.code(404).send({ error: "Feedback not found." });
      uiEventBroker.publish({ type: "feedback.updated", agentId, feedback: updated });
      return { feedback: updated };
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.post("/api/v1/agents/:id/terminal/token", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = params.id ?? "";

    try {
      const access = await agentManager.getTerminalAccess(id);
      if (access.mode === "inert") {
        return {
          mode: "inert" as const,
          message: access.message
        };
      }
      const token = terminalTokenStore.issue(id);
      return {
        mode: "tmux" as const,
        token,
        wsUrl: `/api/v1/agents/${id}/terminal/ws?token=${token}`
      };
    } catch (error) {
      // Keep UI state in sync when terminal access lookup corrected a stale running status.
      const refreshed = await agentManager.getAgent(id);
      if (refreshed) {
        queueGitContextRefresh([refreshed.id]);
        uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(refreshed) });
      }
      return handleAgentError(reply, error);
    }
  });

  app.get(
    "/api/v1/agents/:id/terminal/ws",
    { websocket: true },
    async (connection, request) => {
      const socket = connection.socket;
      const params = request.params as { id?: string };
      const query = request.query as { token?: string; cols?: string; rows?: string };
      const agentId = params.id ?? "";
      const token = query.token ?? "";

      if (!terminalTokenStore.consume(agentId, token)) {
        socket.send(JSON.stringify({ type: "error", message: "Invalid or expired terminal token." }));
        socket.close(1008, "invalid token");
        return;
      }

      let tmuxSession: string;
      try {
        const access = await agentManager.getTerminalAccess(agentId);
        if (access.mode !== "tmux") {
          throw new Error(access.message);
        }
        tmuxSession = access.sessionName;
        await runCommand("tmux", ["set-option", "-t", tmuxSession, "mouse", "on"], {
          allowedExitCodes: [0]
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Terminal attach failed.";
        socket.send(JSON.stringify({ type: "error", message }));
        socket.close(1011, "attach failed");
        return;
      }

      const cols = Number(query.cols ?? 140);
      const rows = Number(query.rows ?? 42);
      const ptyProcess = pty.spawn("tmux", ["attach-session", "-t", tmuxSession], {
        name: "xterm-256color",
        cols: Number.isFinite(cols) ? cols : 140,
        rows: Number.isFinite(rows) ? rows : 42
      });

      const sendJson = (payload: unknown): void => {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(payload));
        }
      };

      ptyProcess.onData((data) => {
        sendJson({ type: "output", data });
      });

      ptyProcess.onExit((event) => {
        sendJson({ type: "exit", exitCode: event.exitCode });
        socket.close(1000, "terminal exited");
      });

      const heartbeatTimer = setInterval(() => {
        sendJson({ type: "heartbeat", ts: Date.now() });
      }, 20_000);

      socket.on("message", (buffer) => {
        const message = decodeClientMessage(buffer);
        if (!message) {
          sendJson({ type: "error", message: "Invalid message payload." });
          return;
        }

        if (message.type === "input") {
          if (!message.data) {
            return;
          }
          ptyProcess.write(message.data);
          return;
        }

        if (message.type === "resize") {
          if (message.cols > 0 && message.rows > 0) {
            ptyProcess.resize(message.cols, message.rows);
          }
        }
      });

      socket.on("close", () => {
        clearInterval(heartbeatTimer);
        try {
          ptyProcess.kill();
        } catch {}
      });
    }
  );

}

async function waitForDatabase(maxAttempts = 15, delayMs = 2000) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch {
      app.log.info(`Waiting for database (attempt ${i}/${maxAttempts})...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error("Database not available after retries");
}

async function start() {
  await waitForDatabase();
  if (process.env.SKIP_MIGRATIONS === "1") {
    app.log.warn("SKIP_MIGRATIONS=1 — skipping database migrations");
  } else {
    await runMigrations();
  }
  config.authToken = await getOrCreateAuthToken(pool);
  await agentManager.reconcileAgents();
  await jobService.reconcileActiveRuns();
  await jobService.startSchedulers();
  const agents = await agentManager.listAgents();
  queueGitContextRefresh(agents.map((agent) => agent.id));
  startGitContextRefreshLoop();
  startAgentStatusReconcileLoop();
  startSessionCleanupTimer();
  await registerRoutes();

  const protocol = config.tls ? "https" : "http";
  await app.listen({
    host: config.host,
    port: config.port
  });
  app.log.info(`Dispatch listening on ${protocol}://${config.host}:${config.port}`);
}

// Global error handlers — prevent silent crashes from background tasks
process.on("unhandledRejection", (reason) => {
  app.log.error({ err: reason }, "Unhandled promise rejection");
});

process.on("uncaughtException", async (err) => {
  app.log.error({ err }, "Uncaught exception — shutting down");
  await shutdown(1);
});

start().catch(async (error) => {
  app.log.error(error);
  await shutdown(1);
});

process.on("SIGINT", async () => {
  await shutdown(0);
});

process.on("SIGTERM", async () => {
  await shutdown(0);
});

function handleAgentError(reply: FastifyReply, error: unknown) {
  if (error instanceof AgentError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }

  const message = error instanceof Error ? error.message : "Unknown error.";
  return reply.code(500).send({ error: message });
}


function ensureGitRefreshAgentDiagnostics(agentId: string): {
  lastQueuedAt: number | null;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  lastDurationMs: number | null;
  lastResult: "updated" | "unchanged" | "probe_error" | "failed" | "skipped" | null;
  lastError: string | null;
} {
  const existing = gitRefreshAgentDiagnostics.get(agentId);
  if (existing) {
    return existing;
  }
  const created = {
    lastQueuedAt: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastDurationMs: null,
    lastResult: null,
    lastError: null
  };
  gitRefreshAgentDiagnostics.set(agentId, created);
  return created;
}

function recordGitRefreshCompletion(
  agentId: string,
  startedAt: number,
  result: "updated" | "unchanged" | "probe_error" | "failed" | "skipped",
  errorMessage: string | null
): void {
  const completedAt = Date.now();
  const durationMs = Math.max(0, completedAt - startedAt);
  gitRefreshCounters.completed += 1;
  if (result === "updated") {
    gitRefreshCounters.updated += 1;
  } else if (result === "unchanged") {
    gitRefreshCounters.unchanged += 1;
  } else if (result === "probe_error") {
    gitRefreshCounters.probeErrors += 1;
  } else if (result === "failed") {
    gitRefreshCounters.failed += 1;
  } else if (result === "skipped") {
    gitRefreshCounters.skipped += 1;
  }

  if (result === "failed" && errorMessage?.includes("Command timed out")) {
    gitRefreshCounters.timedOut += 1;
  }

  gitRefreshDurationsMs.push(durationMs);
  if (gitRefreshDurationsMs.length > GIT_DIAGNOSTICS_HISTORY_LIMIT) {
    gitRefreshDurationsMs.shift();
  }

  const diag = ensureGitRefreshAgentDiagnostics(agentId);
  diag.lastCompletedAt = completedAt;
  diag.lastDurationMs = durationMs;
  diag.lastResult = result;
  diag.lastError = errorMessage;
}

function percentile(sortedValues: number[], quantile: number): number | null {
  if (sortedValues.length === 0) {
    return null;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.floor((sortedValues.length - 1) * quantile))
  );
  return sortedValues[index] ?? null;
}

function toIso(epochMs: number | null): string | null {
  if (epochMs === null) {
    return null;
  }
  return new Date(epochMs).toISOString();
}

function queueGitContextRefresh(agentIds: string[]): void {
  const now = Date.now();
  for (const agentId of agentIds) {
    if (!agentId) {
      continue;
    }
    const existing = gitRefreshAgentDiagnostics.get(agentId);
    const lastQueuedAt = existing?.lastQueuedAt ?? null;
    const wasPending = pendingGitRefreshAgentIds.has(agentId);
    const wasActive = activeGitRefreshAgentIds.has(agentId);
    const queuedRecently =
      lastQueuedAt !== null && now - lastQueuedAt < GIT_CONTEXT_MIN_REQUEUE_MS;
    if (wasPending || wasActive || queuedRecently) {
      continue;
    }
    if (!wasPending && !wasActive) {
      pendingGitRefreshEnqueuedAt.set(agentId, now);
    }
    ensureGitRefreshAgentDiagnostics(agentId).lastQueuedAt = now;
    pendingGitRefreshAgentIds.add(agentId);
    gitRefreshCounters.enqueued += 1;
  }
  void drainGitContextRefreshQueue().catch((err) => {
    app.log.warn({ err }, "Git context refresh queue drain failed");
  });
}

function startGitContextRefreshLoop(): void {
  if (gitContextRefreshTimer) {
    return;
  }
  gitContextRefreshTimer = setInterval(() => {
    void refreshAllAgentGitContexts().catch((err) => {
      app.log.warn({ err }, "Git context refresh cycle failed");
    });
  }, GIT_CONTEXT_REFRESH_INTERVAL_MS);
}

function stopGitContextRefreshLoop(): void {
  if (!gitContextRefreshTimer) {
    return;
  }
  clearInterval(gitContextRefreshTimer);
  gitContextRefreshTimer = null;
}

function startAgentStatusReconcileLoop(): void {
  if (agentStatusReconcileTimer) {
    return;
  }
  agentStatusReconcileTimer = setInterval(() => {
    void runAgentStatusReconciliation().catch((err) => {
      app.log.warn({ err }, "Agent status reconciliation failed");
    });
  }, AGENT_STATUS_RECONCILE_INTERVAL_MS);
}

function stopAgentStatusReconcileLoop(): void {
  if (!agentStatusReconcileTimer) {
    return;
  }
  clearInterval(agentStatusReconcileTimer);
  agentStatusReconcileTimer = null;
}

let sessionCleanupTimer: NodeJS.Timeout | null = null;

function startSessionCleanupTimer(): void {
  if (sessionCleanupTimer) return;
  sessionCleanupTimer = setInterval(() => {
    void cleanExpiredSessions(pool).catch(() => null);
  }, 60 * 60 * 1000); // every hour
}

function stopSessionCleanupTimer(): void {
  if (!sessionCleanupTimer) return;
  clearInterval(sessionCleanupTimer);
  sessionCleanupTimer = null;
}

async function runAgentStatusReconciliation(): Promise<void> {
  try {
    const reconciled = await agentManager.reconcileAgentStatuses();
    for (const agent of reconciled) {
      if (agent.status === "archiving") {
        // Skip if this agent already has an active archive in progress
        if (archivingAgentIds.has(agent.id)) {
          continue;
        }
        // Resume interrupted archive
        console.log(`[reconcile] Agent ${agent.id} (${agent.name}) resuming interrupted archive`);
        uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(agent) });
        // Cleanup mode is persisted on the agent record by beginArchive
        archivingAgentIds.add(agent.id);
        const archivePromise = agentManager.executeArchive(agent.id, {
          onPhaseChange: (updated) => {
            uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(updated) });
          },
          onComplete: (deletedIds) => {
            for (const deletedId of deletedIds) {
              streamManager.stopStream(deletedId);
              pendingGitRefreshAgentIds.delete(deletedId);
              pendingGitRefreshEnqueuedAt.delete(deletedId);
              activeGitRefreshAgentIds.delete(deletedId);
              gitRefreshAgentDiagnostics.delete(deletedId);
              uiEventBroker.publish({ type: "agent.deleted", agentId: deletedId });
            }
          },
          onError: (error) => {
            app.log.error({ err: error, agentId: agent.id }, "Resumed archive failed");
          }
        });
        activeArchives.add(archivePromise);
        archivePromise.finally(() => {
          activeArchives.delete(archivePromise);
          archivingAgentIds.delete(agent.id);
        });
      } else {
        console.log(`[reconcile] Agent ${agent.id} (${agent.name}) status corrected to stopped`);
        uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(agent) });
      }
    }
  } catch (error) {
    app.log.warn({ err: error }, "Agent status reconciliation failed.");
  }
}

async function refreshAllAgentGitContexts(): Promise<void> {
  try {
    const agents = await agentManager.listAgents();
    queueGitContextRefresh(agents.map((agent) => agent.id));
  } catch (error) {
    app.log.warn({ err: error }, "Failed to queue git context refresh.");
  }
}

async function drainGitContextRefreshQueue(): Promise<void> {
  while (
    activeGitRefreshAgentIds.size < GIT_CONTEXT_REFRESH_CONCURRENCY &&
    pendingGitRefreshAgentIds.size > 0
  ) {
    const nextAgentId = pendingGitRefreshAgentIds.values().next().value as string | undefined;
    if (!nextAgentId) {
      return;
    }

    pendingGitRefreshAgentIds.delete(nextAgentId);
    pendingGitRefreshEnqueuedAt.delete(nextAgentId);
    if (activeGitRefreshAgentIds.has(nextAgentId)) {
      continue;
    }

    activeGitRefreshAgentIds.add(nextAgentId);
    gitRefreshCounters.started += 1;
    const startedAt = Date.now();
    const diag = ensureGitRefreshAgentDiagnostics(nextAgentId);
    diag.lastStartedAt = startedAt;
    diag.lastError = null;
    void refreshAgentGitContext(nextAgentId)
      .then((result) => {
        recordGitRefreshCompletion(nextAgentId, startedAt, result, null);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        recordGitRefreshCompletion(nextAgentId, startedAt, "failed", message);
        app.log.warn({ err: error, agentId: nextAgentId }, "Git context refresh failed.");
      })
      .finally(() => {
        activeGitRefreshAgentIds.delete(nextAgentId);
        void drainGitContextRefreshQueue().catch((err) => {
          app.log.warn({ err }, "Git context refresh queue drain failed");
        });
      });
  }
}

async function refreshAgentGitContext(
  agentId: string
): Promise<"updated" | "unchanged" | "probe_error" | "skipped"> {
  const agent = await agentManager.getAgent(agentId);
  if (!agent) {
    return "skipped";
  }

  const cwd = await resolveAgentGitCwd(agent);
  const probe = await probeGitContext(cwd);

  if (probe.status === "error") {
    await persistAgentGitContext(agentId, agent.gitContext, true);
    return "probe_error";
  }

  const nextContext = probe.value;
  const shouldPublish =
    agent.gitContextStale || !areGitContextsEqual(agent.gitContext, nextContext);

  await persistAgentGitContext(agentId, nextContext, false);
  if (!shouldPublish) {
    return "unchanged";
  }

  const refreshed = await agentManager.getAgent(agentId);
  if (refreshed) {
    uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(refreshed) });
  }
  return "updated";
}

async function persistAgentGitContext(
  agentId: string,
  gitContext: AgentGitContext | null,
  stale: boolean
): Promise<void> {
  await pool.query(
    `
    UPDATE agents
    SET git_context = $2::jsonb,
        git_context_stale = $3,
        git_context_updated_at = NOW()
    WHERE id = $1
    `,
    [agentId, gitContext ? JSON.stringify(gitContext) : null, stale]
  );
}

function areGitContextsEqual(
  left: AgentGitContext | null,
  right: AgentGitContext | null
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.repoRoot === right.repoRoot &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    left.worktreeName === right.worktreeName &&
    left.isWorktree === right.isWorktree
  );
}

async function resolveAgentGitCwd(agent: AgentRecord): Promise<string> {
  return agentManager.resolveRuntimeCwd(agent);
}

async function probeGitContext(
  cwd: string
): Promise<{ status: "ok"; value: AgentGitContext | null } | { status: "error" }> {
  try {
    const inside = await runCommand(
      "git",
      ["-C", cwd, "rev-parse", "--is-inside-work-tree"],
      { allowedExitCodes: [0, 128], timeoutMs: PROBE_COMMAND_TIMEOUT_MS }
    );
    if (inside.exitCode !== 0 || inside.stdout !== "true") {
      return { status: "ok", value: null };
    }

    const repoRoot = await resolveRepoRoot(cwd);
    const checkoutRoot = normalizePath(
      (
        await runCommand("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
          allowedExitCodes: [0],
          timeoutMs: PROBE_COMMAND_TIMEOUT_MS
        })
      ).stdout
    );

    let branch = (
      await runCommand("git", ["-C", cwd, "symbolic-ref", "--short", "-q", "HEAD"], {
        allowedExitCodes: [0, 1],
        timeoutMs: PROBE_COMMAND_TIMEOUT_MS
      })
    ).stdout;
    if (!branch) {
      branch = (
        await runCommand("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], {
          allowedExitCodes: [0],
          timeoutMs: PROBE_COMMAND_TIMEOUT_MS
        })
      ).stdout;
    }

    return {
      status: "ok",
      value: {
        repoRoot,
        branch,
        worktreePath: checkoutRoot,
        worktreeName: path.basename(checkoutRoot),
        isWorktree: checkoutRoot !== repoRoot
      }
    };
  } catch {
    return { status: "error" };
  }
}

async function resolveRepoRoot(cwd: string): Promise<string> {
  const commonDirResult = await runCommand(
    "git",
    ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { allowedExitCodes: [0, 128], timeoutMs: PROBE_COMMAND_TIMEOUT_MS }
  );

  if (commonDirResult.exitCode === 0 && commonDirResult.stdout) {
    const commonDir = normalizePath(commonDirResult.stdout);
    if (path.basename(commonDir) === ".git") {
      return normalizePath(path.dirname(commonDir));
    }
  }

  const fallbackCommonDirResult = await runCommand(
    "git",
    ["-C", cwd, "rev-parse", "--git-common-dir"],
    { allowedExitCodes: [0, 128], timeoutMs: PROBE_COMMAND_TIMEOUT_MS }
  );
  if (fallbackCommonDirResult.exitCode === 0 && fallbackCommonDirResult.stdout) {
    const commonDir = fallbackCommonDirResult.stdout;
    const absoluteCommonDir = normalizePath(
      path.isAbsolute(commonDir) ? commonDir : path.resolve(cwd, commonDir)
    );
    if (path.basename(absoluteCommonDir) === ".git") {
      return normalizePath(path.dirname(absoluteCommonDir));
    }
  }

  return normalizePath(
    (
      await runCommand("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
        allowedExitCodes: [0],
        timeoutMs: PROBE_COMMAND_TIMEOUT_MS
      })
    ).stdout
  );
}

async function resolveWorktreeRoot(cwd: string): Promise<string> {
  return normalizePath(
    (
      await runCommand("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
        allowedExitCodes: [0],
        timeoutMs: PROBE_COMMAND_TIMEOUT_MS
      })
    ).stdout
  );
}

function mcpMethodNotAllowed(): { jsonrpc: "2.0"; error: { code: number; message: string }; id: null } {
  return {
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed."
    },
    id: null
  };
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  const trimmed = resolved.replace(/[\\/]+$/, "");
  return trimmed.length > 0 ? trimmed : resolved;
}

function decodeClientMessage(
  buffer: WebSocket.RawData
):
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | null {
  try {
    const asString = typeof buffer === "string" ? buffer : buffer.toString();
    const parsed = JSON.parse(asString) as {
      type?: unknown;
      data?: unknown;
      cols?: unknown;
      rows?: unknown;
    };
    if (parsed.type === "input" && typeof parsed.data === "string") {
      return {
        type: "input",
        data: parsed.data
      };
    }

    if (
      parsed.type === "resize" &&
      typeof parsed.cols === "number" &&
      typeof parsed.rows === "number"
    ) {
      return {
        type: "resize",
        cols: parsed.cols,
        rows: parsed.rows
      };
    }

    return null;
  } catch {
    return null;
  }
}

async function listMediaFiles(
  agentId: string
): Promise<Array<{ name: string; source: string; size: number; updatedAt: string; url: string; description: string | null }>> {
  const result = await pool.query<{
    file_name: string;
    source: string;
    size_bytes: number;
    effective_updated_at: Date;
    description: string | null;
  }>(
    `SELECT file_name, source, size_bytes,
            COALESCE(updated_at, created_at) AS effective_updated_at,
            description
     FROM media WHERE agent_id = $1
     ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 50`,
    [agentId]
  );

  return result.rows.map((row) => ({
    name: row.file_name,
    source: row.source,
    size: row.size_bytes,
    updatedAt: row.effective_updated_at.toISOString(),
    url: `/api/v1/agents/${agentId}/media/${encodeURIComponent(row.file_name)}`,
    description: row.description ?? null
  }));
}

function toMediaKey(file: { name: string; updatedAt: string }): string {
  return `${file.name}:${file.updatedAt}`;
}

function isValidMediaKey(key: string): boolean {
  if (key.length === 0 || key.length > 1024) {
    return false;
  }

  return !/[\u0000-\u001F]/.test(key);
}

async function loadSeenMediaKeys(agentId: string, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) {
    return new Set();
  }

  const result = await pool.query<{ mediaKey: string }>(
    `
    SELECT media_key AS "mediaKey"
    FROM media_seen
    WHERE agent_id = $1 AND media_key = ANY($2::text[])
    `,
    [agentId, keys]
  );

  return new Set(result.rows.map((row) => row.mediaKey));
}

async function markSeenMediaKeys(agentId: string, keys: string[]): Promise<void> {
  if (keys.length === 0) {
    return;
  }

  await pool.query(
    `
    INSERT INTO media_seen (agent_id, media_key, seen_at)
    SELECT $1, key, NOW()
    FROM UNNEST($2::text[]) AS key
    ON CONFLICT (agent_id, media_key) DO UPDATE
      SET seen_at = EXCLUDED.seen_at
    `,
    [agentId, keys]
  );
}

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".yaml", ".yml", ".toml", ".csv", ".log", ".xml",
  ".html", ".css", ".js", ".jsx", ".ts", ".tsx", ".py", ".go", ".rs", ".sh",
  ".sql", ".diff", ".patch", ".env", ".ini", ".cfg", ".conf", ".swift",
  ".kt", ".java", ".c", ".cpp", ".h", ".hpp", ".rb", ".php", ".lua",
  ".zig", ".nim", ".r", ".m", ".ex", ".exs", ".erl", ".hs",
]);

function isTextFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

function isMediaFile(name: string): boolean {
  return /\.(png|jpg|jpeg|gif|webp|mp4)$/i.test(name) || isTextFile(name);
}

function mimeType(name: string): string {
  if (/\.png$/i.test(name)) {
    return "image/png";
  }

  if (/\.jpe?g$/i.test(name)) {
    return "image/jpeg";
  }

  if (/\.gif$/i.test(name)) {
    return "image/gif";
  }

  if (/\.webp$/i.test(name)) {
    return "image/webp";
  }

  if (/\.mp4$/i.test(name)) {
    return "video/mp4";
  }

  if (/\.json$/i.test(name)) {
    return "application/json";
  }

  if (/\.xml$/i.test(name)) {
    return "application/xml";
  }

  if (/\.html$/i.test(name)) {
    return "text/html";
  }

  if (/\.css$/i.test(name)) {
    return "text/css";
  }

  if (/\.(js|jsx|mjs)$/i.test(name)) {
    return "text/javascript";
  }

  if (/\.csv$/i.test(name)) {
    return "text/csv";
  }

  if (/\.md$/i.test(name)) {
    return "text/markdown";
  }

  if (/\.ya?ml$/i.test(name)) {
    return "text/yaml";
  }

  if (isTextFile(name)) {
    return "text/plain";
  }

  return "application/octet-stream";
}

function resolveMediaDir(agentId: string, mediaDir: string | null): string {
  return mediaDir ?? path.join(config.mediaRoot, agentId);
}

let shuttingDown = false;
async function shutdown(code: number): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  jobService.stopAllSchedulers();
  streamManager.stopAll();
  stopGitContextRefreshLoop();
  stopAgentStatusReconcileLoop();
  stopSessionCleanupTimer();

  // Wait for in-flight archives to finish so clean shutdowns don't leave agents stuck in "archiving"
  if (activeArchives.size > 0) {
    app.log.info({ count: activeArchives.size }, "Waiting for in-flight archives to complete…");
    const ARCHIVE_DRAIN_TIMEOUT_MS = 10_000;
    await Promise.race([
      Promise.allSettled(activeArchives),
      new Promise((resolve) => setTimeout(resolve, ARCHIVE_DRAIN_TIMEOUT_MS)),
    ]);
  }

  await pool.end().catch(() => null);
  await app.close().catch(() => null);
  process.exit(code);
}

function isAgentLatestEventType(value: unknown): value is AgentLatestEventType {
  return typeof value === "string" && AGENT_LATEST_EVENT_TYPES.includes(value as AgentLatestEventType);
}

async function mcpUpsertEvent(
  agentId: string,
  event: { type: string; message: string; metadata?: Record<string, unknown> }
): Promise<void> {
  if (!isAgentLatestEventType(event.type)) {
    throw new Error(`type must be one of: ${AGENT_LATEST_EVENT_TYPES.join(", ")}.`);
  }
  const agent = await agentManager.upsertLatestEvent(agentId, {
    type: event.type,
    message: event.message.trim(),
    metadata: event.metadata
  });
  uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(agent) });
}

async function mcpSubmitFeedback(
  agentId: string,
  feedback: import("./agents/manager.js").FeedbackInput
): Promise<FeedbackRecord> {
  const record = await agentManager.submitFeedback(agentId, feedback);
  uiEventBroker.publish({ type: "feedback.created", agentId, feedback: record });
  return record;
}

async function mcpGetFeedback(
  agentId: string,
  opts: { persona?: string; limit?: number }
) {
  return agentManager.listFeedbackByParentGrouped(agentId, opts.persona, opts.limit);
}

async function mcpResolveFeedback(
  agentId: string,
  feedbackId: number,
  status: "fixed" | "ignored"
): Promise<import("./agents/manager.js").FeedbackRecord> {
  const record = await agentManager.updateFeedbackStatusByParent(feedbackId, agentId, status);
  if (!record) throw new Error(`Feedback #${feedbackId} not found or not owned by a child of this agent.`);
  uiEventBroker.publish({ type: "feedback.updated", agentId: record.agentId, feedback: record });
  return record;
}

async function mcpUpsertPin(
  agentId: string,
  pin: { label: string; value: string; type: string }
): Promise<void> {
  if (!isPinType(pin.type)) {
    throw new Error(`Invalid pin type: ${pin.type}`);
  }
  validatePinValue(pin.type, pin.value);
  const agent = await agentManager.upsertPin(agentId, {
    label: pin.label,
    value: pin.value,
    type: pin.type
  });
  uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(agent) });
}

async function mcpDeletePin(
  agentId: string,
  label: string
): Promise<void> {
  const agent = await agentManager.deletePin(agentId, label);
  uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(agent) });
}

async function mcpUpdateReviewStatus(
  agentId: string,
  input: { status: string; message?: string }
): Promise<void> {
  const review = await agentManager.updatePersonaReviewStatus(agentId, input);
  // Notify UI — both the child (owns the review data) and the parent need to re-render
  const [child, parent] = await Promise.all([
    agentManager.getAgent(agentId),
    agentManager.getAgent(review.parentAgentId),
  ]);
  if (child) uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(child) });
  if (parent) uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(parent) });
}

async function mcpCompleteReview(
  agentId: string,
  input: { verdict: string; summary: string; filesReviewed?: string[]; message?: string }
): Promise<void> {
  const review = await agentManager.completePersonaReview(agentId, input);
  const [child, parent] = await Promise.all([
    agentManager.getAgent(agentId),
    agentManager.getAgent(review.parentAgentId),
  ]);
  if (child) uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(child) });
  if (parent) uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(parent) });
}

async function mcpGetParentContext(
  parentAgentId: string
): Promise<import("@dispatch/shared/mcp/server.js").ParentContextResult> {
  const parent = await agentManager.getAgent(parentAgentId);
  if (!parent) throw new Error("Parent agent not found.");

  const pins = (parent.pins ?? []).map((p) => ({
    label: p.label,
    value: p.value,
    type: p.type
  }));

  const media = await agentManager.listMedia(parentAgentId);

  return {
    pins,
    media: media.map((m) => ({
      fileName: m.fileName,
      description: m.description,
      source: m.source,
      createdAt: m.createdAt
    }))
  };
}

async function mcpJobComplete(agentId: string, report: unknown): Promise<{ runId: string; status: string }> {
  const run = await jobService.completeRunForAgent(agentId, report);
  return { runId: run.id, status: run.status };
}

async function mcpJobFailed(agentId: string, report: unknown): Promise<{ runId: string; status: string }> {
  const run = await jobService.failRunForAgent(agentId, report);
  return { runId: run.id, status: run.status };
}

async function mcpJobNeedsInput(agentId: string, question: string): Promise<{ runId: string; status: string }> {
  const run = await jobService.markNeedsInputForAgent(agentId, question);
  return { runId: run.id, status: run.status };
}

async function mcpJobLog(
  agentId: string,
  input: { task: string; message: string; level: "debug" | "info" | "warn" | "error" }
): Promise<{ runId: string; status: string }> {
  const run = await jobService.logForAgent(agentId, input);
  return { runId: run.id, status: run.status };
}

async function mcpLaunchPersona(
  agentId: string,
  opts: { persona: string; context: string }
): Promise<{ agentId: string; persona: string; parentAgentId: string }> {
  const parent = await agentManager.getAgent(agentId);
  if (!parent) throw new Error("Parent agent not found.");

  const parentCwd = parent.worktreePath ?? parent.cwd;
  // Try worktree root first (persona files may be uncommitted), then repo root
  let personaRoot: string;
  try {
    personaRoot = await resolveWorktreeRoot(parentCwd);
  } catch {
    try {
      personaRoot = await resolveRepoRoot(parentCwd);
    } catch {
      throw new Error("Parent agent is not in a git repository.");
    }
  }

  let persona = await loadPersonaBySlug(personaRoot, opts.persona);
  if (!persona) {
    // Fall back to repo root if worktree root didn't have it
    try {
      const repoRoot = await resolveRepoRoot(parentCwd);
      if (repoRoot !== personaRoot) {
        persona = await loadPersonaBySlug(repoRoot, opts.persona);
      }
    } catch {}
  }
  if (!persona) {
    throw new Error(`Persona "${opts.persona}" not found in .dispatch/personas/.`);
  }

  // Generate git diff for context — detect the base branch rather than assuming main
  let diff = "";
  try {
    const { runCommand } = await import("@dispatch/shared/lib/run-command.js");
    let baseBranch = "main";
    let baseBranchDetected = true;
    try {
      const headRef = await runCommand(
        "git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
        { cwd: parentCwd }
      );
      // Returns e.g. "origin/main" — strip the remote prefix
      baseBranch = headRef.stdout.trim().replace(/^origin\//, "");
    } catch {
      baseBranchDetected = false;
    }
    const diffResult = await runCommand("git", ["diff", `${baseBranch}...HEAD`], { cwd: parentCwd });
    diff = diffResult.stdout;
    if (!baseBranchDetected && !diff.trim()) {
      diff = `(Note: base branch detection failed; diff was generated against "${baseBranch}". If this looks wrong, the repo may use a different default branch.)`;
    }
  } catch {
    diff = "(unable to generate diff)";
  }

  const prompt = assemblePersonaPrompt(persona, opts.context, diff);

  // Build agent args — include full access flag if parent has it
  const personaArgs: string[] = [`--append-system-prompt`, prompt];
  if (parent.fullAccess) {
    const fullAccessArg =
      parent.type === "claude" ? CLAUDE_FULL_ACCESS_ARG
      : parent.type === "codex" ? CODEX_FULL_ACCESS_ARG
      : null;
    if (fullAccessArg) personaArgs.push(fullAccessArg);
  }

  // For Claude persona agents, pre-assign a session ID so we know exactly which
  // session file belongs to this agent. buildAgentCommand handles adding the
  // --session-id flag; we just store it on the agent record here.
  const cliSessionId = parent.type === "claude" ? randomUUID() : undefined;

  const agent = await agentManager.createAgent({
    name: `${opts.persona}-${agentId.slice(-6)}`,
    type: parent.type,
    cwd: parentCwd,
    agentArgs: personaArgs,
    fullAccess: parent.fullAccess,
    useWorktree: false,
    persona: opts.persona,
    parentAgentId: agentId,
    personaContext: opts.context,
    cliSessionId,
  });

  // Create the persona review record
  await agentManager.createPersonaReview({
    agentId: agent.id,
    parentAgentId: agentId,
    persona: opts.persona,
  });

  // Re-fetch so the SSE event includes the review subquery data
  const agentWithReview = await agentManager.getAgent(agent.id);

  queueGitContextRefresh([agent.id]);
  uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(agentWithReview ?? agent) });

  // Send initial prompt to the persona agent after it starts up
  if (agent.tmuxSession) {
    const tmuxSession = agent.tmuxSession;
    const initialMessage = "Begin your review now. Follow your system prompt instructions.";
    setTimeout(async () => {
      try {
        const { runCommand: run } = await import("@dispatch/shared/lib/run-command.js");
        await run("tmux", ["send-keys", "-t", tmuxSession, "-l", initialMessage]);
        await run("tmux", ["send-keys", "-t", tmuxSession, "Enter"]);
      } catch {}
    }, 10_000);
  }

  return { agentId: agent.id, persona: opts.persona, parentAgentId: agentId };
}

async function mcpShareMedia(
  agentId: string,
  opts: { filePath: string; description: string; source?: string; name?: string; update?: string }
): Promise<{ fileName: string; url: string; sizeBytes: number; source: string; description: string }> {
  const agent = await agentManager.getAgent(agentId);
  if (!agent) throw new Error("Agent not found.");

  if (!isMediaFile(opts.filePath)) {
    throw new Error("Unsupported file type. Use png/jpg/jpeg/gif/webp/mp4 or text files (txt/md/json/yaml/ts/py/etc).");
  }

  const isText = isTextFile(opts.filePath);
  const validSources = ["screenshot", "stream", "simulator", "text"];
  const source = isText ? "text" : (opts.source && validSources.includes(opts.source) ? opts.source : "screenshot");

  const buffer = await readFile(opts.filePath);
  const mediaDir = resolveMediaDir(agentId, agent.mediaDir);
  await mkdir(mediaDir, { recursive: true });

  // Update existing media file
  if (opts.update) {
    const existing = await pool.query<{ file_name: string }>(
      `SELECT file_name FROM media WHERE agent_id = $1 AND file_name = $2 FOR UPDATE`,
      [agentId, opts.update]
    );
    if (existing.rows.length === 0) {
      throw new Error(`No media file found with the given fileName for this agent.`);
    }

    const fileName = existing.rows[0].file_name;
    const filePath = path.join(mediaDir, fileName);
    const resolvedMediaDir = path.resolve(mediaDir);
    if (!path.resolve(filePath).startsWith(resolvedMediaDir + path.sep)) {
      throw new Error("Invalid media file path.");
    }

    await writeFile(filePath, buffer);

    await pool.query(
      `UPDATE media SET size_bytes = $1, description = $2, updated_at = NOW()
       WHERE agent_id = $3 AND file_name = $4`,
      [buffer.length, opts.description, agentId, fileName]
    );

    uiEventBroker.publish({ type: "media.changed", agentId });

    return {
      fileName,
      url: `/api/v1/agents/${agentId}/media/${encodeURIComponent(fileName)}`,
      sizeBytes: buffer.length,
      source,
      description: opts.description
    };
  }

  // Create new media file
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").replace("Z", "");
  const baseName = opts.name ?? path.basename(opts.filePath);
  const ext0 = path.extname(baseName).toLowerCase();
  const fallbackExt = ext0 === ".mp4" ? ".mp4" : isText ? (ext0 || ".txt") : ".png";
  const safeName = baseName.replace(/ /g, "-").replace(/[^A-Za-z0-9._-]/g, "") || `shared-${timestamp}${fallbackExt}`;
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);
  const fileName = `${base}-${timestamp}${ext}`;

  await writeFile(path.join(mediaDir, fileName), buffer);

  await pool.query(
    `INSERT INTO media (agent_id, file_name, source, size_bytes, description)
     VALUES ($1, $2, $3, $4, $5)`,
    [agentId, fileName, source, buffer.length, opts.description]
  );

  uiEventBroker.publish({ type: "media.changed", agentId });

  return {
    fileName,
    url: `/api/v1/agents/${agentId}/media/${encodeURIComponent(fileName)}`,
    sizeBytes: buffer.length,
    source,
    description: opts.description
  };
}
