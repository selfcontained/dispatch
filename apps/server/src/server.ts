import path from "node:path";
import os from "node:os";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";
import type { FastifyReply } from "fastify";
import * as z from "zod/v4";

import { AgentError, AgentManager } from "./agents/manager.js";
import type { AgentRecord } from "./agents/manager.js";
import {
  isPasswordSet,
  validateSession,
  cleanExpiredSessions,
  getOrCreateAuthToken,
  getOrCreateCookieSecret,
  getReleaseUpdateAgentId,
  isScopedMcpRoute,
  shouldAcceptApiBearerToken,
  validateAgentMcpToken,
  validateJobMcpToken,
} from "./auth.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { deleteSetting, getSetting, setSetting } from "./db/settings.js";
import { runCommand } from "./shared/lib/run-command.js";
import { shouldSkipAutomaticMacPathProbe } from "./shared/mac-path-privacy.js";
import {
  isMediaFile,
  isTextFile,
  mimeType,
  resolveMediaDir,
} from "./shared/media.js";
import { handleMcpRequest } from "./shared/mcp/server.js";
import { readReleaseStore, writeReleaseStore } from "./release-store.js";
import {
  inspectAssistedUpdateMetadata,
  isAssistedUpdateRequired,
  type AssistedUpdateMetadata,
} from "./release-metadata.js";
import {
  buildAssistedUpdateContext,
  applyAssistedPhase,
  attachAssistedAgent,
  runAndRecordChecks,
} from "./assisted-update.js";
import {
  readAssistedUpdateState,
  clearAssistedUpdateState,
  isTerminalPhase,
  type AssistedPhase,
  type AssistedUpdateState,
} from "./assisted-update-store.js";
import {
  ensureCachedTarball,
  pruneCacheExcept,
  readCachedTarball,
  readMigrationsFromTarball,
  unlinkCachedTarball,
} from "./release-tarball-cache.js";
import {
  loadUpdateMigrations,
  type UpdateMigrationManifest,
} from "./update-migrations.js";
import {
  appliedIdSet,
  readAppliedMigrationsState,
} from "./applied-migrations-store.js";
import {
  clearEvaluatorCache,
  evaluatePendingMigrations,
  toSummary,
  type PendingMigrationSummary,
} from "./update-migrations-evaluator.js";
import { StreamManager } from "./stream-manager.js";
import {
  SlackNotifier,
  isValidSlackWebhookUrl,
} from "./notifications/slack.js";
import { JobNotifier } from "./notifications/job-notifier.js";
import { FocusTracker } from "./focus-tracker.js";
import { TerminalTokenStore } from "./terminal/token-store.js";
import { TmuxTerminal } from "./terminal/tmux-terminal.js";
import { AGENT_TYPES, setEnabledAgentTypes } from "./agent-type-settings.js";
import { validatePinValue } from "./pins.js";
import { JobService } from "./jobs/service.js";
import { ReleaseLogStreamProcessor } from "./release-log-stream.js";
import { staticFiles as embeddedStaticFiles } from "./generated/runtime-assets.js";
import { randomUUID } from "node:crypto";
import { registerActivityRoutes } from "./routes/activity.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerFeedbackRoutes } from "./routes/feedback.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerPersonaReviewRoutes } from "./routes/persona-reviews.js";
import { registerReleaseRoutes } from "./routes/release.js";
import { registerStaticRoutes } from "./routes/static.js";
import { registerSystemRoutes } from "./routes/system.js";
import {
  dateTruncTz,
  escapeLike,
  loadScopedActivityEvents,
  parseActivityQuery,
  timeRangeClause,
} from "./server/activity-query.js";
import {
  createGitContextRuntime,
  percentile,
  toIso,
} from "./server/git-context-runtime.js";
import {
  createReleaseRuntime,
  type ReleaseJob,
  RELEASE_VERSION_TYPES,
} from "./server/release-runtime.js";
import {
  createMcpHandlers,
  mcpMethodNotAllowed,
} from "./server/mcp-handlers.js";
import { UiEventBroker, type UiEvent } from "./server/ui-events.js";

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
const JOB_TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "timed_out",
  "crashed",
]);
jobService.onRunStateChange((run) => {
  uiEventBroker.publish({ type: "job.changed" });
  void jobNotifier.onJobRunStateChange(run).catch((err) => {
    app.log.warn({ err, runId: run.id }, "Job run state notification failed");
  });
  // Auto-archive job agents when the run reaches a terminal state.
  // needs_input is excluded — user may need to interact with the agent.
  // Jobs with autoArchive=false keep the agent around for post-run follow-up.
  const shouldAutoArchive = run.config?.autoArchive ?? true;
  if (
    JOB_TERMINAL_STATUSES.has(run.status) &&
    run.agentId &&
    shouldAutoArchive
  ) {
    void autoArchiveJobAgent(run.agentId).catch((err) => {
      app.log.warn(
        { err, agentId: run.agentId },
        "Auto-archive of job agent failed"
      );
    });
  }
});
// Suppress agent-level Slack notifications for job agents (job notifier handles those).
// Job agents are named "job-*" — skip the DB lookup for regular agents.
// When web notifications are enabled and an SSE client is connected, broadcast
// a notification via SSE and wait for an ack from any client. If no ack arrives
// within the timeout, fall back to Slack.
const WEB_NOTIFY_ACK_TIMEOUT_MS = 3_000;
const pendingWebNotifications = new Map<string, NodeJS.Timeout>();

type CreateAgentBody = {
  name?: unknown;
  type?: unknown;
  cwd?: unknown;
  agentArgs?: unknown;
  codexArgs?: unknown;
  fullAccess?: unknown;
  useWorktree?: unknown;
  createNewBranch?: unknown;
  worktreeBranch?: unknown;
  baseBranch?: unknown;
  persona?: unknown;
  parentAgentId?: unknown;
  personaContext?: unknown;
  autoReview?: unknown;
  initialPrompt?: unknown;
  startupLinks?: unknown;
};

type StartupFileUpload = {
  fileName: string;
  originalName: string;
  buffer: Buffer;
  source: "text" | "user";
  description: string | null;
};

const MAX_STARTUP_FILE_COUNT = 10;
const MAX_STARTUP_FILE_NAME_LENGTH = 128;

function parseOptionalBooleanField(
  value: unknown,
  fieldName: string,
  allowStringCoercion: boolean
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (allowStringCoercion && value === "true") return true;
  if (allowStringCoercion && value === "false") return false;
  throw new Error(`${fieldName} must be a boolean when provided.`);
}

function parseOptionalStringArrayField(
  value: unknown,
  fieldName: string,
  allowStringCoercion: boolean
): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  if (!allowStringCoercion || typeof value !== "string") {
    throw new Error(`${fieldName} must be an array of strings.`);
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
    ) {
      return parsed;
    }
  } catch {}
  throw new Error(`${fieldName} must be an array of strings.`);
}

function createStartupPins(urls: string[]): Array<{
  label: string;
  value: string;
  type: "url";
}> {
  const counts = new Map<string, number>();
  return urls.map((rawUrl) => {
    validatePinValue("url", rawUrl);
    const hostname = new URL(rawUrl).hostname.replace(/^www\./, "") || "Link";
    const seen = counts.get(hostname) ?? 0;
    counts.set(hostname, seen + 1);
    return {
      label: seen === 0 ? hostname : `${hostname} ${seen + 1}`,
      value: rawUrl,
      type: "url",
    };
  });
}

function sanitizeUploadedFileName(name: string): string {
  const ext = path.extname(name).toLowerCase();
  const baseName = path.basename(name, ext).normalize("NFKD");
  const collapsed = baseName
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._() -]+/g, "-")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return `${collapsed || "file"}${ext}`;
}

function sanitizeStartupDisplayName(
  name: string | undefined,
  fallback: string
): string {
  const normalized = path
    .basename(name || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (!normalized) {
    return fallback;
  }
  return normalized.slice(0, MAX_STARTUP_FILE_NAME_LENGTH);
}

async function parseCreateAgentRequest(request: {
  body?: unknown;
  isMultipart: () => boolean;
  parts: () => AsyncIterable<unknown>;
}): Promise<{
  body: CreateAgentBody;
  startupFiles: StartupFileUpload[];
  isMultipart: boolean;
}> {
  const multipart = request.isMultipart();
  if (!multipart) {
    return {
      body: (request.body as CreateAgentBody | undefined) ?? {},
      startupFiles: [],
      isMultipart: false,
    };
  }

  const body: CreateAgentBody = {};
  const startupFiles: StartupFileUpload[] = [];

  for await (const rawPart of request.parts()) {
    const part = rawPart as {
      type: "file" | "field";
      fieldname: string;
      filename?: string;
      value?: unknown;
      toBuffer?: () => Promise<Buffer>;
    };
    if (part.type === "file") {
      if (part.fieldname !== "startupFiles") {
        throw new Error("Unexpected file field.");
      }
      if (startupFiles.length >= MAX_STARTUP_FILE_COUNT) {
        throw new Error(
          `A maximum of ${MAX_STARTUP_FILE_COUNT} startup files is allowed.`
        );
      }
      const fileName = sanitizeUploadedFileName(
        path.basename(part.filename || "")
      );
      if (!fileName) {
        throw new Error("Invalid file name.");
      }
      if (!isMediaFile(fileName)) {
        throw new Error(
          "Unsupported file type. Use images (png/jpg/gif/webp), video (mp4), documents (pdf), or text files (txt/md/json/yaml/ts/py/etc)."
        );
      }
      if (!part.toBuffer) {
        throw new Error("Invalid file upload.");
      }
      startupFiles.push({
        fileName,
        originalName: sanitizeStartupDisplayName(part.filename, fileName),
        buffer: await part.toBuffer(),
        source: isTextFile(fileName) ? "text" : "user",
        description: null,
      });
      continue;
    }

    body[part.fieldname as keyof CreateAgentBody] = part.value;
  }

  return { body, startupFiles, isMultipart: true };
}

/** Called by the ack endpoint when a client confirms delivery. */
function ackWebNotification(notificationId: string): boolean {
  const timer = pendingWebNotifications.get(notificationId);
  if (!timer) return false;
  clearTimeout(timer);
  pendingWebNotifications.delete(notificationId);
  return true;
}

agentManager.onLatestEvent((agent) => {
  const sendSlackNotification = async () => {
    if (!agent.name?.startsWith("job-")) {
      await slackNotifier.onAgentEvent(agent);
      return;
    }
    const run = await jobService.getLatestRunForAgent(agent.id);
    if (!run) await slackNotifier.onAgentEvent(agent);
  };

  void (async () => {
    try {
      // Check if we should attempt a web notification.
      // Conditions: web notifications enabled, event type configured, agent not focused.
      const webPayload = await slackNotifier.shouldWebNotify(agent);
      if (webPayload && uiEventBroker.hasConnectedClient()) {
        // Broadcast notification via SSE with a unique ID.
        // If any client acks within the timeout, Slack is suppressed.
        // Otherwise fall back to Slack.
        const notificationId = randomUUID();
        uiEventBroker.publish({
          type: "notification",
          notificationId,
          ...webPayload,
        });

        const fallbackTimer = setTimeout(() => {
          pendingWebNotifications.delete(notificationId);
          app.log.debug(
            { notificationId, agentId: agent.id },
            "Web notification not acked — falling back to Slack"
          );
          void sendSlackNotification();
        }, WEB_NOTIFY_ACK_TIMEOUT_MS);

        pendingWebNotifications.set(notificationId, fallbackTimer);
      } else {
        await sendSlackNotification();
      }
    } catch (err) {
      app.log.warn({ err, agentId: agent.id }, "Agent notification failed");
    }
  })();
});
const activeArchives = new Set<Promise<void>>();
const archivingAgentIds = new Set<string>();

async function autoArchiveJobAgent(agentId: string): Promise<void> {
  if (archivingAgentIds.has(agentId)) return;
  try {
    const agent = await agentManager.beginArchive(agentId, "auto");
    uiEventBroker.publish({
      type: "agent.upsert",
      agent: withStreamFlag(agent),
    });
    archivingAgentIds.add(agentId);
    const archivePromise = agentManager.executeArchive(agentId, {
      onPhaseChange: (updated) => {
        uiEventBroker.publish({
          type: "agent.upsert",
          agent: withStreamFlag(updated),
        });
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

    const mediaDir = resolveMediaDir(agentId, agent.mediaDir, config.mediaRoot);
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

const AGENT_STATUS_RECONCILE_INTERVAL_MS = 30_000;
let agentStatusReconcileTimer: NodeJS.Timeout | null = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRootDir = path.resolve(__dirname, "..");
const staticAssets = new Map(
  embeddedStaticFiles.map((asset) => [
    asset.routePath,
    {
      contentType: asset.contentType,
      body: Buffer.from(asset.base64, "base64"),
    },
  ])
);
const indexHtmlTemplate =
  staticAssets.get("/index.html")?.body.toString("utf8") ?? "";
const manifestTemplate =
  staticAssets.get("/manifest.webmanifest")?.body.toString("utf8") ?? "";

// ---------------------------------------------------------------------------
// Icon color templating — rewrite index.html and manifest for active color
// ---------------------------------------------------------------------------
const VALID_ICON_COLORS = [
  "teal",
  "blue",
  "purple",
  "red",
  "orange",
  "amber",
  "pink",
  "cyan",
] as const;
type IconColor = (typeof VALID_ICON_COLORS)[number];
const DEFAULT_ICON_COLOR: IconColor = "teal";
const ICON_COLOR_KEY = "icon_color";

let cachedIconColor: IconColor = DEFAULT_ICON_COLOR;
let cachedIndexHtml: string = indexHtmlTemplate;
let cachedManifest: string = manifestTemplate;

function rewriteForColor(color: IconColor): void {
  cachedIconColor = color;
  if (color === DEFAULT_ICON_COLOR) {
    cachedIndexHtml = indexHtmlTemplate;
    cachedManifest = manifestTemplate;
  } else {
    cachedIndexHtml = indexHtmlTemplate.replaceAll(
      "/icons/teal/",
      `/icons/${color}/`
    );
    cachedManifest = manifestTemplate.replaceAll(
      "/icons/teal/",
      `/icons/${color}/`
    );
  }
}

function withStreamFlag<T extends AgentRecord>(
  agent: T
): T & { hasStream: boolean } {
  return { ...agent, hasStream: streamManager.hasStream(agent.id) };
}

const serverDir =
  process.env.DISPATCH_SERVER_DIR ??
  path.join(os.homedir(), ".dispatch", "server");
const releaseRuntime = createReleaseRuntime({
  pool,
  config,
  serverDir,
  appRootDir,
  runCommand,
  readReleaseStore: () => readReleaseStore(),
  writeReleaseStore: (record) => writeReleaseStore(record),
  readAssistedUpdateState: () => readAssistedUpdateState(),
  isTerminalPhase,
  ensureCachedTarball,
  pruneCacheExcept,
  unlinkCachedTarball,
  createReleaseLogStreamProcessor: (sinks, onLine) =>
    new ReleaseLogStreamProcessor(sinks, onLine),
});
const gitContextRuntime = createGitContextRuntime({
  pool,
  agentManager,
  appLog: app.log,
  publishUiEvent: (event) => uiEventBroker.publish(event as UiEvent),
  withStreamFlag,
  probeCommandTimeoutMs: PROBE_COMMAND_TIMEOUT_MS,
  refreshIntervalMs: GIT_CONTEXT_REFRESH_INTERVAL_MS,
  refreshConcurrency: GIT_CONTEXT_REFRESH_CONCURRENCY,
  minRequeueMs: GIT_CONTEXT_MIN_REQUEUE_MS,
  diagnosticsHistoryLimit: GIT_DIAGNOSTICS_HISTORY_LIMIT,
});
const mcpHandlers = createMcpHandlers({
  pool,
  mediaRoot: config.mediaRoot,
  agentManager,
  jobService,
  slackNotifier,
  resolveRepoRoot: gitContextRuntime.resolveRepoRoot,
  resolveWorktreeRoot: gitContextRuntime.resolveWorktreeRoot,
  queueGitContextRefresh: gitContextRuntime.queue,
  publishUiEvent: (event) => uiEventBroker.publish(event as UiEvent),
  withStreamFlag,
  sendAgentPrompt: injectTmuxPrompt,
});

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
const WORKTREE_LOCATION_KEY = "worktree_location";
type WorktreeLocation = "sibling" | "nested";
const VALID_WORKTREE_LOCATIONS: WorktreeLocation[] = ["sibling", "nested"];

async function registerRoutes() {
  const cookieSecret = await getOrCreateCookieSecret(pool);
  await app.register(fastifyCookie, { secret: cookieSecret });
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 20 * 1024 * 1024,
      files: MAX_STARTUP_FILE_COUNT,
      fields: 24,
      parts: 32,
    },
  });
  await app.register(fastifyWebsocket);
  await app.register(fastifyRateLimit, { global: false });

  // Initialize icon color from DB before serving any requests
  const storedIconColor = await getSetting(pool, ICON_COLOR_KEY);
  if (
    storedIconColor &&
    (VALID_ICON_COLORS as readonly string[]).includes(storedIconColor)
  ) {
    rewriteForColor(storedIconColor as IconColor);
  }

  await registerStaticRoutes(app, {
    cachedIndexHtml,
    cachedManifest,
    staticAssets,
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
    // The assisted-update phase endpoint authenticates via a per-job nonce
    // embedded in the launched agent's prompt — see assisted-update.ts. The
    // agent runs as a separate process and does not share the server's
    // session cookie or bearer token.
    if (url === "/api/v1/release/assisted/phase") return;

    // If no password is set, all routes are open (first-run mode).
    if (!(await isPasswordSetCached())) return;

    // Bearer token is accepted on all API routes (for MCP agents, scripts, etc.)
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      if (shouldAcceptApiBearerToken(url, token, config.authToken)) {
        return;
      }
      if (isScopedMcpRoute(url)) {
        return;
      }
    }

    // Session cookie
    const signed = request.cookies[SESSION_COOKIE];
    if (signed) {
      const unsigned = request.unsignCookie(signed);
      if (
        unsigned.valid &&
        unsigned.value &&
        (await validateSession(pool, unsigned.value))
      ) {
        return;
      }
    }

    return reply.code(401).send({ error: "Authentication required." });
  });

  // ---------------------------------------------------------------------------
  // Auth routes
  // ---------------------------------------------------------------------------
  await registerAuthRoutes(app, {
    pool,
    tls: config.tls,
    sessionCookie: SESSION_COOKIE,
    sessionMaxAgeSeconds: SESSION_MAX_AGE_S,
    isPasswordSetCached,
    invalidatePasswordSetCache,
  });

  await registerJobRoutes(app, {
    jobService,
    publishUiEvent: (event) => uiEventBroker.publish(event as UiEvent),
  });

  await registerMcpRoutes(app, {
    config,
    agentManager,
    jobService,
    getBearerToken,
    validateJobMcpToken,
    validateAgentMcpToken,
    resolveRepoRoot: gitContextRuntime.resolveRepoRoot,
    resolveWorktreeRoot: gitContextRuntime.resolveWorktreeRoot,
    mcpSendNotify: mcpHandlers.sendNotify,
    mcpUpsertEvent: mcpHandlers.upsertEvent,
    mcpRenameSession: mcpHandlers.renameSession,
    mcpShareMedia: mcpHandlers.shareMedia,
    mcpListMedia: mcpHandlers.listMedia,
    mcpSubmitFeedback: mcpHandlers.submitFeedback,
    mcpListPersonas: mcpHandlers.listPersonas,
    mcpLaunchPersona: mcpHandlers.launchPersona,
    mcpGetFeedback: mcpHandlers.getFeedback,
    mcpResolveFeedback: mcpHandlers.resolveFeedback,
    mcpSubmitResolution: mcpHandlers.submitResolution,
    mcpCancelRecheck: mcpHandlers.cancelRecheck,
    mcpUpsertPin: mcpHandlers.upsertPin,
    mcpDeletePin: mcpHandlers.deletePin,
    mcpGetParentContext: mcpHandlers.getParentContext,
    mcpGetRecheckContext: mcpHandlers.getRecheckContext,
    mcpUpdateReviewStatus: mcpHandlers.updateReviewStatus,
    mcpCompleteReview: mcpHandlers.completeReview,
    mcpJobComplete: mcpHandlers.jobComplete,
    mcpJobFailed: mcpHandlers.jobFailed,
    mcpJobNeedsInput: mcpHandlers.jobNeedsInput,
    mcpJobLog: mcpHandlers.jobLog,
    mcpMethodNotAllowed,
  });

  await registerSystemRoutes(app, {
    pool,
    appLog: app.log,
    slackNotifier,
    iconColorKey: ICON_COLOR_KEY,
    validIconColors: VALID_ICON_COLORS,
    getCachedIconColor: () => cachedIconColor,
    rewriteForColor: (color) => rewriteForColor(color as IconColor),
    pendingGitRefreshEnqueuedAt: gitContextRuntime.pendingEnqueuedAt,
    gitRefreshDurationsMs: gitContextRuntime.durationsMs,
    gitRefreshAgentDiagnostics: gitContextRuntime.agentDiagnostics,
    pendingGitRefreshAgentIds: gitContextRuntime.pendingAgentIds,
    activeGitRefreshAgentIds: gitContextRuntime.activeAgentIds,
    gitRefreshCounters: gitContextRuntime.counters,
    probeCommandTimeoutMs: PROBE_COMMAND_TIMEOUT_MS,
    gitContextRefreshIntervalMs: GIT_CONTEXT_REFRESH_INTERVAL_MS,
    gitContextRefreshConcurrency: GIT_CONTEXT_REFRESH_CONCURRENCY,
    percentile,
    toIso,
  });

  await registerActivityRoutes(app, {
    pool,
    agentManager,
    parseActivityQuery,
    loadScopedActivityEvents: (aq) => loadScopedActivityEvents(pool, aq),
    timeRangeClause,
    dateTruncTz,
    escapeLike,
  });

  await registerReleaseRoutes(app, {
    pool,
    appLog: app.log,
    config,
    serverDir,
    agentManager,
    worktreeLocationKey: WORKTREE_LOCATION_KEY,
    validWorktreeLocations: VALID_WORKTREE_LOCATIONS,
    getActiveReleaseJob: releaseRuntime.getActiveReleaseJob,
    setActiveReleaseJob: (job) => {
      releaseRuntime.setActiveReleaseJob(job as ReleaseJob | null);
    },
    getActiveAssistedUpdateLaunch: releaseRuntime.getActiveAssistedUpdateLaunch,
    setActiveAssistedUpdateLaunch: releaseRuntime.setActiveAssistedUpdateLaunch,
    releaseStreamClients: releaseRuntime.releaseStreamClients,
    getAppVersionInfo: releaseRuntime.getAppVersionInfo,
    getGitHubRepo: releaseRuntime.getGitHubRepo,
    parseGhJson: releaseRuntime.parseGhJson,
    compareSemver: releaseRuntime.compareSemver,
    checkIsAdmin: releaseRuntime.checkIsAdmin,
    fetchReleaseMetadata: releaseRuntime.fetchReleaseMetadata,
    fetchLatestReleaseMetadata: releaseRuntime.fetchLatestReleaseMetadata,
    dispatchBaseUrl: releaseRuntime.dispatchBaseUrl,
    dispatchHealthUrl: releaseRuntime.dispatchHealthUrl,
    defaultServiceRestartCommand: releaseRuntime.defaultServiceRestartCommand,
    buildAssistedUpdatePrompt: releaseRuntime.buildAssistedUpdatePrompt,
    hasActiveAssistedUpdateAgent: releaseRuntime.hasActiveAssistedUpdateAgent,
    broadcastReleaseEvent: releaseRuntime.broadcastReleaseEvent,
    appendReleaseLog: releaseRuntime.appendReleaseLog,
    rehydrateActiveAssistedJob: releaseRuntime.rehydrateActiveAssistedJob,
    runReleaseJob: releaseRuntime.runReleaseJob,
    runUpdateJob: releaseRuntime.runUpdateJob,
    getBearerToken,
    queueGitContextRefresh: gitContextRuntime.queue,
    publishUiEvent: (event) => uiEventBroker.publish(event as UiEvent),
    withStreamFlag,
    handleAgentError,
  });

  await registerMediaRoutes(app, {
    pool,
    mediaRoot: config.mediaRoot,
    agentManager,
    publishUiEvent: (event) => uiEventBroker.publish(event as UiEvent),
  });

  await registerAgentRoutes(app, {
    pool,
    appLog: app.log,
    agentManager,
    worktreeLocationKey: WORKTREE_LOCATION_KEY,
    validWorktreeLocations: VALID_WORKTREE_LOCATIONS,
    queueGitContextRefresh: gitContextRuntime.queue,
    publishUiEvent: (event) => uiEventBroker.publish(event as UiEvent),
    subscribeUiEvents: (stream) => uiEventBroker.subscribe(stream),
    sendUiSnapshot: (stream, agents) =>
      uiEventBroker.sendSnapshot(stream, agents),
    ackWebNotification,
    clearFocusedAgents: () => focusTracker.clearAll(),
    setFocusedAgent: (agentId) => focusTracker.setFocused(agentId),
    withStreamFlag,
    handleAgentError,
    startStream: (agentId, port) => streamManager.startStream(agentId, port),
    stopStream: (agentId, description) =>
      streamManager.stopStream(agentId, description),
    hasStream: (agentId) => streamManager.hasStream(agentId),
    addStreamViewer: (agentId, stream) =>
      streamManager.addViewer(agentId, stream),
    issueTerminalToken: (agentId) => terminalTokenStore.issue(agentId),
    consumeTerminalToken: (agentId, token) =>
      terminalTokenStore.consume(agentId, token),
    onArchivedAgentsDeleted: (deletedIds) => {
      for (const deletedId of deletedIds) {
        streamManager.stopStream(deletedId);
        gitContextRuntime.clearAgent(deletedId);
        uiEventBroker.publish({
          type: "agent.deleted",
          agentId: deletedId,
        });
      }
    },
    onArchiveError: (agentId, error) => {
      app.log.error({ err: error, agentId }, "Background archive failed");
    },
    trackArchivePromise: (agentId, archivePromise) => {
      archivingAgentIds.add(agentId);
      activeArchives.add(archivePromise);
      archivePromise.finally(() => {
        activeArchives.delete(archivePromise);
        archivingAgentIds.delete(agentId);
      });
    },
  });

  // --- Personas ---
  await registerPersonaReviewRoutes(app, {
    pool,
    agentManager,
    resolveWorktreeRoot: gitContextRuntime.resolveWorktreeRoot,
    resolveRepoRoot: gitContextRuntime.resolveRepoRoot,
    mcpLaunchPersona: mcpHandlers.launchPersona,
    mcpCancelRecheck: mcpHandlers.cancelRecheck,
    sendAgentPrompt: (agentId, prompt) =>
      injectTmuxPrompt(agentId, prompt, { swallowFailure: false }),
    publishUiEvent: (event) => uiEventBroker.publish(event as UiEvent),
    withStreamFlag,
    handleAgentError,
  });

  // --- Feedback ---

  await registerFeedbackRoutes(app, {
    agentManager,
    publishUiEvent: (event) => uiEventBroker.publish(event as UiEvent),
    handleAgentError,
  });
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

let routesRegistered = false;

export async function initializeApp(options?: {
  runMigrations?: boolean;
  reconcileState?: boolean;
}): Promise<typeof app> {
  await waitForDatabase();
  const shouldRunMigrations =
    options?.runMigrations ?? process.env.SKIP_MIGRATIONS !== "1";
  if (!shouldRunMigrations) {
    app.log.warn("SKIP_MIGRATIONS=1 — skipping database migrations");
  } else {
    await runMigrations();
  }
  config.authToken = await getOrCreateAuthToken(pool);
  const shouldReconcileState = options?.reconcileState ?? true;
  if (shouldReconcileState) {
    await agentManager.reconcileAgents();
    await jobService.reconcileActiveRuns();
    await jobService.startSchedulers();
    // If we crashed/restarted mid-assisted-update, repopulate the
    // in-memory job from the on-disk state file so the operator UI
    // surfaces the in-flight phase right away.
    await releaseRuntime.rehydrateActiveAssistedJob();
    const agents = await agentManager.listAgents();
    gitContextRuntime.queue(agents.map((agent) => agent.id));
    gitContextRuntime.startLoop();
    startAgentStatusReconcileLoop();
    startSessionCleanupTimer();
  }
  if (!routesRegistered) {
    await registerRoutes();
    routesRegistered = true;
  }
  await app.ready();
  return app;
}

export async function closeApp(): Promise<void> {
  await cleanupAppResources();
}

export async function start() {
  await initializeApp();

  const protocol = config.tls ? "https" : "http";
  await app.listen({
    host: config.host,
    port: config.port,
  });
  app.log.info(
    `Dispatch listening on ${protocol}://${config.host}:${config.port}`
  );
}

export { app, shutdown };

function handleAgentError(reply: FastifyReply, error: unknown) {
  if (error instanceof AgentError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }

  const message = error instanceof Error ? error.message : "Unknown error.";
  return reply.code(500).send({ error: message });
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
  sessionCleanupTimer = setInterval(
    () => {
      void cleanExpiredSessions(pool).catch(() => null);
    },
    60 * 60 * 1000
  ); // every hour
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
        console.log(
          `[reconcile] Agent ${agent.id} (${agent.name}) resuming interrupted archive`
        );
        uiEventBroker.publish({
          type: "agent.upsert",
          agent: withStreamFlag(agent),
        });
        // Cleanup mode is persisted on the agent record by beginArchive
        archivingAgentIds.add(agent.id);
        const archivePromise = agentManager.executeArchive(agent.id, {
          onPhaseChange: (updated) => {
            uiEventBroker.publish({
              type: "agent.upsert",
              agent: withStreamFlag(updated),
            });
          },
          onComplete: (deletedIds) => {
            for (const deletedId of deletedIds) {
              streamManager.stopStream(deletedId);
              gitContextRuntime.clearAgent(deletedId);
              uiEventBroker.publish({
                type: "agent.deleted",
                agentId: deletedId,
              });
            }
          },
          onError: (error) => {
            app.log.error(
              { err: error, agentId: agent.id },
              "Resumed archive failed"
            );
          },
        });
        activeArchives.add(archivePromise);
        archivePromise.finally(() => {
          activeArchives.delete(archivePromise);
          archivingAgentIds.delete(agent.id);
        });
      } else {
        console.log(
          `[reconcile] Agent ${agent.id} (${agent.name}) status corrected to stopped`
        );
        uiEventBroker.publish({
          type: "agent.upsert",
          agent: withStreamFlag(agent),
        });
      }
    }
  } catch (error) {
    app.log.warn({ err: error }, "Agent status reconciliation failed.");
  }
}

let shuttingDown = false;
async function cleanupAppResources(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  jobService.stopAllSchedulers();
  streamManager.stopAll();
  gitContextRuntime.stopLoop();
  stopAgentStatusReconcileLoop();
  stopSessionCleanupTimer();

  // Cancel pending web notification fallback timers so they don't fire
  // Slack notifications after the pool is closed.
  for (const timer of pendingWebNotifications.values()) {
    clearTimeout(timer);
  }
  pendingWebNotifications.clear();

  // Wait for in-flight archives to finish so clean shutdowns don't leave agents stuck in "archiving"
  if (activeArchives.size > 0) {
    app.log.info(
      { count: activeArchives.size },
      "Waiting for in-flight archives to complete…"
    );
    const ARCHIVE_DRAIN_TIMEOUT_MS = 10_000;
    await Promise.race([
      Promise.allSettled(activeArchives),
      new Promise((resolve) => setTimeout(resolve, ARCHIVE_DRAIN_TIMEOUT_MS)),
    ]);
  }

  await pool.end().catch(() => null);
  await app.close().catch(() => null);
}

async function shutdown(code: number): Promise<void> {
  await cleanupAppResources();
  process.exit(code);
}

function getBearerToken(request: {
  headers: Record<string, unknown>;
}): string | null {
  const authHeader = request.headers.authorization;
  if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  return authHeader.slice(7);
}

async function injectTmuxPrompt(
  agentId: string,
  prompt: string,
  opts: { swallowFailure?: boolean } = {}
): Promise<void> {
  try {
    const access = await agentManager.getTerminalAccess(agentId);
    if (access.mode !== "tmux") {
      app.log.debug(
        { agentId, mode: access.mode },
        "Skipping tmux injection — agent has no tmux session"
      );
      return;
    }
    const terminal = new TmuxTerminal(access.sessionName);
    await terminal.sendCommand(prompt);
  } catch (error) {
    if (opts.swallowFailure === false) {
      throw error;
    }
    app.log.warn(
      { err: error, agentId },
      "Failed to inject tmux prompt — agent may have exited"
    );
  }
}
