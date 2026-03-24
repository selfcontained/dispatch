import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";
import type { FastifyReply } from "fastify";
import type WebSocket from "ws";
import pty from "node-pty";

import { AgentError, AgentManager } from "./agents/manager.js";
import type { AgentGitContext, AgentRecord } from "./agents/manager.js";
import {
  isPasswordSet,
  setPassword,
  verifyPassword,
  createSession,
  validateSession,
  deleteSession,
  changePassword,
  cleanExpiredSessions,
  getOrCreateCookieSecret
} from "./auth.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { runCommand } from "./lib/run-command.js";
import { handleMcpRequest } from "./mcp/server.js";
import { readReleaseStore, writeReleaseStore } from "./release-store.js";
import { StreamManager } from "./stream-manager.js";
import { SlackNotifier } from "./notifications/slack.js";
import { TerminalTokenStore } from "./terminal/token-store.js";

const config = loadConfig();
const app = Fastify({
  logger: true,
  ...(config.tls && { https: { cert: config.tls.cert, key: config.tls.key } }),
});
const pool = createPool(config);
const agentManager = new AgentManager(pool, app.log, config);
const slackNotifier = new SlackNotifier(pool, app.log);
agentManager.onLatestEvent((agent) => void slackNotifier.onAgentEvent(agent));
const terminalTokenStore = new TerminalTokenStore(60_000);

const AGENT_LATEST_EVENT_TYPES = ["working", "blocked", "waiting_user", "done", "idle"] as const;
const CODEX_FULL_ACCESS_ARG = "--dangerously-bypass-approvals-and-sandbox";
const CLAUDE_FULL_ACCESS_ARG = "--dangerously-skip-permissions";
type AgentLatestEventType = (typeof AGENT_LATEST_EVENT_TYPES)[number];
type UiEvent =
  | { type: "snapshot"; agents: AgentRecord[] }
  | { type: "agent.upsert"; agent: AgentRecord }
  | { type: "agent.deleted"; agentId: string }
  | { type: "media.changed"; agentId: string }
  | { type: "media.seen"; agentId: string; keys: string[] }
  | { type: "stream.started"; agentId: string }
  | { type: "stream.stopped"; agentId: string };

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
const releaseNotesFile = path.join(appRootDir, "release-notes", "current.md");
const webDistDir = path.resolve(__dirname, "../web/dist");
const legacyPublicDir = path.resolve(__dirname, "../public");
const staticDir = existsSync(webDistDir) ? webDistDir : legacyPublicDir;

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
      ["-C", appRootDir, "rev-parse", "--short=12", "HEAD"],
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

/** Strip ANSI escape sequences for clean log display */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
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

    let buffer = "";
    let lastWasCR = false;
    const processChunk = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const rawLine of lines) {
        // Detect ANSI cursor-up sequence (ESC[<N>A) used by tools like
        // `gh run watch` to redraw multi-line output blocks in-place.
        const cursorUpMatch = rawLine.match(/\x1b\[(\d+)A/);
        if (cursorUpMatch) {
          rewindReleaseLog(job, parseInt(cursorUpMatch[1], 10));
        }

        const line = stripAnsi(rawLine);

        // A line may contain \r-separated segments (in-place terminal updates).
        // Only the final segment matters; earlier ones were meant to be overwritten.
        const crParts = line.split("\r").filter(Boolean);
        if (crParts.length > 1 || lastWasCR) {
          // Replace the previous log entry with the last \r segment
          const final = crParts[crParts.length - 1] ?? "";
          replaceReleaseLog(job, final);
          onLine?.(final);
        } else {
          appendReleaseLog(job, crParts[0] ?? line);
          onLine?.(crParts[0] ?? line);
        }
        lastWasCR = false;
      }
      // If the remaining buffer contains \r, the next output will overwrite
      if (buffer.includes("\r")) {
        const crParts = buffer.split("\r").filter(Boolean);
        const final = crParts[crParts.length - 1] ?? "";
        replaceReleaseLog(job, final);
        onLine?.(final);
        buffer = "";
        lastWasCR = true;
      }
    };

    child.stdout.on("data", processChunk);
    child.stderr.on("data", processChunk);

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (buffer) {
        appendReleaseLog(job, buffer);
        onLine?.(buffer);
      }
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

/** Shared deploy logic: checkout tag, install, build, write record, restart */
async function deployTag(job: ReleaseJob, tag: string): Promise<void> {
  setReleasePhase(job, "deploying");

  appendReleaseLog(job, `==> checking out ${tag}`);
  await runCommand("git", ["-C", serverDir, "checkout", tag]);

  appendReleaseLog(job, "==> installing dependencies");
  await streamProcess("npm", ["ci", "--silent"], { cwd: serverDir }, job);
  await streamProcess("npm", ["--prefix", "web", "ci", "--silent"], { cwd: serverDir }, job);

  appendReleaseLog(job, "==> building");
  await streamProcess("npm", ["run", "build"], { cwd: serverDir }, job);

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
    appendReleaseLog(job, `==> release workflow produced tag: ${tag}`);

    await deployTag(job, tag);
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

async function registerRoutes() {
  const cookieSecret = await getOrCreateCookieSecret(pool);
  await app.register(fastifyCookie, { secret: cookieSecret });
  await app.register(fastifyMultipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  await app.register(fastifyWebsocket);

  await app.register(fastifyStatic, {
    root: staticDir,
    prefix: "/",
    setHeaders(res, filePath) {
      // Never HTTP-cache the files the service worker & browser use to
      // bootstrap an update check.  Hashed assets (JS/CSS with content-hash
      // in the filename) are safe to cache indefinitely — a rebuild produces
      // a new URL so stale entries are never served.
      const base = path.basename(filePath);
      if (
        base === "index.html" ||
        base === "sw.js" ||
        base === "manifest.webmanifest"
      ) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      }
    }
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
    if (url.endsWith("/terminal/ws")) return;

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

  app.post("/api/v1/auth/setup", async (request, reply) => {
    if (await isPasswordSetCached()) {
      return reply.code(400).send({ error: "Password is already set." });
    }
    const body = request.body as { password?: string } | null;
    const password = body?.password;
    if (!password || typeof password !== "string" || password.length < 4) {
      return reply.code(400).send({ error: "Password must be at least 4 characters." });
    }
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

  app.post("/api/v1/auth/login", async (request, reply) => {
    const body = request.body as { password?: string } | null;
    const password = body?.password;
    if (!password || typeof password !== "string") {
      return reply.code(400).send({ error: "Password is required." });
    }
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

  app.post("/api/v1/auth/change-password", async (request, reply) => {
    // Requires valid session (enforced by hook).
    const body = request.body as { currentPassword?: string; newPassword?: string } | null;
    const currentPassword = body?.currentPassword;
    const newPassword = body?.newPassword;
    if (!currentPassword || !newPassword || typeof currentPassword !== "string" || typeof newPassword !== "string") {
      return reply.code(400).send({ error: "currentPassword and newPassword are required." });
    }
    if (newPassword.length < 4) {
      return reply.code(400).send({ error: "New password must be at least 4 characters." });
    }
    const changed = await changePassword(pool, currentPassword, newPassword);
    if (!changed) {
      return reply.code(401).send({ error: "Current password is incorrect." });
    }
    invalidatePasswordSetCache();
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // MCP routes
  // ---------------------------------------------------------------------------

  app.post("/api/mcp", async (request, reply) => {
    reply.hijack();
    await handleMcpRequest(request.raw, reply.raw, request.body);
  });

  app.post("/api/mcp/:agentId", async (request, reply) => {
    const params = request.params as { agentId?: string };
    const agentId = params.agentId ?? "";
    const agent = await agentManager.getAgent(agentId);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
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
      upsertEvent: mcpUpsertEvent,
      shareMedia: mcpShareMedia
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

      if (isAdmin && currentTag) {
        const refCheck = await runCommand(
          "git", ["-C", serverDir, "rev-parse", "--verify", currentTag],
          { allowedExitCodes: [0, 128] }
        );
        if (refCheck.exitCode !== 0) {
          refMissing = true;
        } else {
          const countResult = await runCommand("git", [
            "-C", serverDir,
            "rev-list", `${currentTag}..origin/main`, "--count"
          ]);
          unreleasedCount = Number(countResult.stdout) || 0;

          if (unreleasedCount > 0) {
            const logResult = await runCommand("git", [
              "-C", serverDir,
              "log", `${currentTag}..origin/main`,
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

  app.get("/api/v1/system/defaults", async () => {
    return {
      homeDir: os.homedir()
    };
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
    const agent = await agentManager.getAgent(id);
    if (!agent) {
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
    const agent = await agentManager.getAgent(id);
    if (!agent) {
      return reply.code(404).send({ error: "Agent not found." });
    }

    const file = params.file ?? "";
    if (!/^[A-Za-z0-9._-]+$/.test(file)) {
      return reply.code(400).send({ error: "Invalid media file name." });
    }

    const filePath = path.join(resolveMediaDir(agent.id, agent.mediaDir), file);
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

    const fileName = data.filename;
    if (!isMediaFile(fileName)) {
      return reply.code(400).send({ error: "Unsupported file type. Use png/jpg/jpeg/gif/webp/mp4." });
    }

    const sourceField = (data.fields.source as { value?: string } | undefined)?.value ?? "screenshot";
    const validSources = ["screenshot", "stream", "simulator"];
    const source = validSources.includes(sourceField) ? sourceField : "screenshot";
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
<title>${agent.name} — Live Stream</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0a0a0a;display:flex;align-items:center;justify-content:center;height:100vh;overflow:hidden}
  img{max-width:100%;max-height:100%;object-fit:contain}
  .gone{display:flex;align-items:center;justify-content:center;height:100vh;color:#666;font-family:system-ui;font-size:14px}
</style>
</head><body>
<img id="feed" src="/api/v1/agents/${id}/stream" alt="Live stream">
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

    const agentArgs = providedAgentArgs as string[] | undefined;
    const agentType = body.type === "claude" ? "claude" : body.type === "opencode" ? "opencode" : "codex";
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
      const agent = await agentManager.createAgent({
        name: typeof body.name === "string" ? body.name : undefined,
        type: agentType,
        cwd: body.cwd,
        agentArgs: resolvedAgentArgs,
        fullAccess: body.fullAccess === true
      });
      queueGitContextRefresh([agent.id]);
      uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(agent) });
      return reply.code(201).send({ agent });
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

  app.delete("/api/v1/agents/:id", async (request, reply) => {
    const params = request.params as { id?: unknown };
    const query = request.query as { force?: unknown };

    if (typeof params.id !== "string") {
      return reply.code(400).send({ error: "Missing agent id." });
    }

    const force = query.force === "true" || query.force === true;
    if (query.force !== undefined && typeof query.force !== "string" && typeof query.force !== "boolean") {
      return reply.code(400).send({ error: "force must be true or false." });
    }

    try {
      const existing = await agentManager.getAgent(params.id);
      await agentManager.deleteAgent(params.id, force);
      if (existing) {
        streamManager.stopStream(existing.id);
        pendingGitRefreshAgentIds.delete(existing.id);
        pendingGitRefreshEnqueuedAt.delete(existing.id);
        activeGitRefreshAgentIds.delete(existing.id);
        gitRefreshAgentDiagnostics.delete(existing.id);
        uiEventBroker.publish({ type: "agent.deleted", agentId: existing.id });
      }
      return reply.code(204).send();
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
  await runMigrations();
  await agentManager.reconcileAgents();
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
  void drainGitContextRefreshQueue();
}

function startGitContextRefreshLoop(): void {
  if (gitContextRefreshTimer) {
    return;
  }
  gitContextRefreshTimer = setInterval(() => {
    void refreshAllAgentGitContexts();
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
    void runAgentStatusReconciliation();
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
      console.log(`[reconcile] Agent ${agent.id} (${agent.name}) status corrected to stopped`);
      uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(agent) });
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
        void drainGitContextRefreshQueue();
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
    created_at: Date;
    description: string | null;
  }>(
    `SELECT file_name, source, size_bytes, created_at, description
     FROM media WHERE agent_id = $1
     ORDER BY created_at DESC LIMIT 50`,
    [agentId]
  );

  return result.rows.map((row) => ({
    name: row.file_name,
    source: row.source,
    size: row.size_bytes,
    updatedAt: row.created_at.toISOString(),
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

function isMediaFile(name: string): boolean {
  return /\.(png|jpg|jpeg|gif|webp|mp4)$/i.test(name);
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

  streamManager.stopAll();
  stopGitContextRefreshLoop();
  stopAgentStatusReconcileLoop();
  stopSessionCleanupTimer();
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

async function mcpShareMedia(
  agentId: string,
  opts: { filePath: string; description: string; source?: string; name?: string }
): Promise<{ fileName: string; url: string; sizeBytes: number; source: string; description: string }> {
  const agent = await agentManager.getAgent(agentId);
  if (!agent) throw new Error("Agent not found.");

  if (!isMediaFile(opts.filePath)) {
    throw new Error("Unsupported file type. Use png/jpg/jpeg/gif/webp/mp4.");
  }

  const validSources = ["screenshot", "stream", "simulator"];
  const source = opts.source && validSources.includes(opts.source) ? opts.source : "screenshot";

  const buffer = await readFile(opts.filePath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").replace("Z", "");
  const baseName = opts.name ?? path.basename(opts.filePath);
  const ext0 = path.extname(baseName).toLowerCase();
  const fallbackExt = ext0 === ".mp4" ? ".mp4" : ".png";
  const safeName = baseName.replace(/ /g, "-").replace(/[^A-Za-z0-9._-]/g, "") || `shared-${timestamp}${fallbackExt}`;
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);
  const fileName = `${base}-${timestamp}${ext}`;

  const mediaDir = resolveMediaDir(agentId, agent.mediaDir);
  await mkdir(mediaDir, { recursive: true });
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
