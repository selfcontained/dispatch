import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
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
import type WebSocket from "ws";
import * as z from "zod/v4";

import { spawn as spawnPty } from "./shared/terminal/bun-pty.js";

import { AgentError, AgentManager } from "./agents/manager.js";
import type {
  AgentGitContext,
  AgentRecord,
  FeedbackRecord,
} from "./agents/manager.js";
import {
  loadPersonas,
  loadPersonaBySlug,
  assemblePersonaPrompt,
} from "./personas/loader.js";
import { buildPersonaReviewDiff } from "./personas/review-diff.js";
import {
  buildParentRound1FeedbackPrompt,
  buildParentReviewCompletePrompt,
  buildPersonaKickoffPrompt,
  buildReviewerRecheckCancelledPrompt,
  buildReviewerRecheckReadyPrompt,
} from "./reviews/injection-prompts.js";
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
import { resolveHeadSha } from "./shared/git/worktree.js";
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
  type NotifyInput,
  type NotifyResult,
} from "./notifications/slack.js";
import { JobNotifier } from "./notifications/job-notifier.js";
import { FocusTracker } from "./focus-tracker.js";
import { TerminalTokenStore } from "./terminal/token-store.js";
import { TmuxTerminal } from "./terminal/tmux-terminal.js";
import {
  AGENT_TYPES,
  CLI_AGENT_TYPES,
  getEnabledAgentTypes,
  isCliAgentType,
  setEnabledAgentTypes,
} from "./agent-type-settings.js";
import { isPinType, validatePinValue } from "./pins.js";
import { JobService } from "./jobs/service.js";
import { randomUUID } from "node:crypto";
import { ReleaseLogStreamProcessor } from "./release-log-stream.js";
import {
  releaseNotesMarkdown,
  staticFiles as embeddedStaticFiles,
} from "./generated/runtime-assets.js";
import { type ActivityEventRow } from "./activity-metrics.js";
import { registerActivityRoutes } from "./routes/activity.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerFeedbackRoutes } from "./routes/feedback.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerPersonaReviewRoutes } from "./routes/persona-reviews.js";
import {
  registerReleaseRoutes,
  type ReleaseJob as RouteReleaseJob,
} from "./routes/release.js";
import { registerStaticRoutes } from "./routes/static.js";
import { registerSystemRoutes } from "./routes/system.js";

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
const AGENT_INITIAL_PROMPT_MAX_CHARS = 16_000;
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

const AGENT_LATEST_EVENT_TYPES = [
  "working",
  "blocked",
  "waiting_user",
  "done",
  "idle",
] as const;
const CODEX_FULL_ACCESS_ARG = "--dangerously-bypass-approvals-and-sandbox";
const CLAUDE_FULL_ACCESS_ARG = "--dangerously-skip-permissions";
type AgentLatestEventType = (typeof AGENT_LATEST_EVENT_TYPES)[number];
type ActivityGranularity = "hour" | "day" | "week" | "month";
type UiEvent =
  | { type: "snapshot"; agents: AgentRecord[] }
  | { type: "agent.upsert"; agent: AgentRecord }
  | { type: "agent.deleted"; agentId: string }
  | { type: "media.changed"; agentId: string }
  | { type: "media.seen"; agentId: string; keys: string[] }
  | { type: "stream.started"; agentId: string }
  | { type: "stream.stopped"; agentId: string }
  | {
      type: "feedback.created";
      agentId: string;
      feedback: import("./agents/manager.js").FeedbackRecord;
    }
  | {
      type: "feedback.updated";
      agentId: string;
      feedback: import("./agents/manager.js").FeedbackRecord;
    }
  | { type: "job.changed" }
  | {
      type: "notification";
      notificationId: string;
      agentId: string;
      agentName: string;
      eventType: string;
      message: string;
    };

class UiEventBroker {
  private clients = new Set<NodeJS.WritableStream>();
  private nextId = 1;

  subscribe(stream: NodeJS.WritableStream): () => void {
    this.clients.add(stream);
    return () => {
      this.clients.delete(stream);
    };
  }

  /** Returns true if at least one SSE client is currently connected. */
  hasConnectedClient(): boolean {
    return this.clients.size > 0;
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
const pendingGitRefreshAgentIds = new Set<string>();

type ActivityQuery = {
  start: Date | null;
  end: Date | null;
  tz: string;
  granularity: ActivityGranularity;
};

const VALID_GRANULARITIES = new Set<ActivityGranularity>([
  "hour",
  "day",
  "week",
  "month",
]);
const FALLBACK_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const VALID_TIMEZONES = new Set(Intl.supportedValuesOf("timeZone"));

function parseActivityQuery(query: Record<string, unknown>): ActivityQuery {
  const startStr = typeof query.start === "string" ? query.start : "";
  const endStr = typeof query.end === "string" ? query.end : "";
  const rawTz =
    typeof query.tz === "string" && query.tz ? query.tz : FALLBACK_TZ;
  const tz = VALID_TIMEZONES.has(rawTz) ? rawTz : FALLBACK_TZ;
  const gran =
    typeof query.granularity === "string" ? query.granularity : "day";

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

function dateTruncTz(
  granularity: ActivityGranularity,
  column: string,
  tz: string
): string {
  const escaped = tz.replace(/'/g, "''");
  const trunc = `date_trunc('${granularity}', ${column} AT TIME ZONE '${escaped}')`;
  if (granularity === "hour") {
    return `to_char(${trunc}, 'YYYY-MM-DD HH24:00')`;
  }
  return `${trunc}::date::text`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
    lastResult:
      | "updated"
      | "unchanged"
      | "probe_error"
      | "failed"
      | "skipped"
      | null;
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
  skipped: 0,
};
let gitContextRefreshTimer: NodeJS.Timeout | null = null;

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
    const packageJson = JSON.parse(
      await readFile(path.join(appRootDir, "package.json"), "utf8")
    ) as {
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

// ---------------------------------------------------------------------------
// Release manager
// ---------------------------------------------------------------------------

const RELEASE_VERSION_TYPES = ["patch", "minor", "major"] as const;
type ReleaseVersionType = (typeof RELEASE_VERSION_TYPES)[number];
// Per-job-type phase sets. Each ReleaseJob variant owns its own subset
// so an "update" job can't accidentally hold a "validate" phase, and an
// assisted job's `assisted` payload becomes non-optional.
type CreatePhase = "preflight" | "triggering" | "watching" | "done" | "failed";
type UpdatePhase = "fetching" | "deploying" | "restarting" | "done" | "failed";
// `restarting` deliberately overlaps with UpdatePhase — both surfaces
// reuse the same UI label and the same SSE phase event for the
// host-level service restart that follows `apply`.
type AssistedReleasePhase = AssistedPhase;

// Broad union exposed on the wire `phase` event — receivers don't know
// which variant produced it, so they accept any phase.
type ReleasePhase = CreatePhase | UpdatePhase | AssistedReleasePhase;

type ReleaseJobType = "create" | "update" | "update-assisted";

type CommonReleaseJobFields = {
  startedAt: string;
  log: string[];
  runUrl: string | null;
  tag: string | null;
  error: string | null;
};

type ReleaseJob =
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
      /**
       * Mirrors the on-disk state so the UI snapshot has phase / checks
       * / agent id without a follow-up request. Required on the
       * assisted variant — the gate flow always populates it before the
       * job is published.
       */
      assisted: AssistedUpdateState;
    });

type ReleaseStreamEvent =
  | { type: "snapshot"; job: ReleaseJob | null }
  | { type: "log"; line: string }
  | { type: "log.replace"; line: string }
  | { type: "log.rewind"; count: number }
  | { type: "phase"; phase: ReleasePhase; error?: string }
  | { type: "runUrl"; url: string }
  | { type: "tag"; tag: string }
  | { type: "assisted"; state: AssistedUpdateState };

let activeReleaseJob: ReleaseJob | null = null;
let activeAssistedUpdateLaunch = false;
const releaseStreamClients = new Set<NodeJS.WritableStream>();

/**
 * If the server was restarted mid-assisted-update (the framework's
 * worst-case crash mode for migration-driven releases), the in-memory
 * `activeReleaseJob` is gone but `~/.dispatch/assisted-update.json`
 * still describes the reached phase. Rebuild a minimal `update-assisted`
 * job from disk so the operator UI sees the in-flight state on boot
 * instead of a blank "no job" snapshot.
 *
 * Called once during boot and again on every SSE connect — the latter
 * is a belt-and-braces guard against a snapshot subscriber arriving
 * before whatever boot path fired this.
 */
async function rehydrateActiveAssistedJob(): Promise<void> {
  if (activeReleaseJob) return;
  const state = await readAssistedUpdateState().catch(() => null);
  if (!state || isTerminalPhase(state.phase)) return;
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

const serverDir =
  process.env.DISPATCH_SERVER_DIR ??
  path.join(os.homedir(), ".dispatch", "server");

function dispatchHealthUrl(): string {
  return `${dispatchBaseUrl()}/api/v1/health`;
}

function dispatchBaseUrl(): string {
  const protocol = config.tls ? "https" : "http";
  return `${protocol}://127.0.0.1:${config.port}`;
}

function defaultServiceRestartCommand(): string {
  return process.platform === "linux"
    ? "systemctl --user restart dispatch"
    : "launchctl kickstart -k gui/$(id -u)/com.dispatch.server";
}

async function hasActiveAssistedUpdateAgent(): Promise<boolean> {
  const result = await pool.query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM agents
      WHERE deleted_at IS NULL
        AND role = 'assisted_update'
        AND cwd = $1
        AND status IN ('creating', 'running', 'stopping', 'unknown')
    `,
    [serverDir]
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
- Production checkout: ${serverDir}
- Health endpoint: ${dispatchHealthUrl()}
- Dispatch API base URL: $DISPATCH_API_URL
- Dispatch API update token env: $DISPATCH_RELEASE_UPDATE_TOKEN
- Main service log: ~/.dispatch/logs/dispatch.log
- Failure log path: ~/.dispatch/logs/last-release-failure.log
- Service restart command: ${serviceCommand}

Guardrails:
- Operate on ${serverDir}, not the user's development worktree.
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

    const processor = new ReleaseLogStreamProcessor(
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
    const result = await runCommand("git", [
      "-C",
      serverDir,
      "remote",
      "get-url",
      "origin",
    ]);
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
    const result = await runCommand("gh", [
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

/**
 * Try to deploy from a pre-built release tarball attached to the GitHub release.
 * Returns true on success, false if the artifact isn't available (caller falls
 * back to building from source).
 *
 * The tarball is fetched directly over HTTPS (no `gh release download`) and
 * cached at `~/.dispatch/cache/release-<tag>.tar.gz`. The same cached file
 * is reused by the assisted-update inspection path so we never download the
 * same artifact twice.
 */
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
    cached = await ensureCachedTarball({
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
  await runCommand("git", ["-C", serverDir, "checkout", tag]);

  // Validate tarball contents before extraction — reject entries with path
  // traversal (../) or absolute paths. macOS bsdtar does NOT block these by
  // default, so this is a real risk if a compromised release artifact is uploaded.
  // If the tarball itself is unreadable (truncated/corrupt), drop the cache
  // entry so the next deploy re-downloads instead of looping on a bad file.
  appendReleaseLog(job, "==> validating artifact contents");
  let listing: Awaited<ReturnType<typeof runCommand>>;
  try {
    listing = await runCommand("tar", ["tzf", cached.path]);
  } catch (err) {
    await unlinkCachedTarball(tag);
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
    await runCommand("tar", [
      "xzf",
      cached.path,
      "--no-same-owner",
      "-C",
      serverDir,
    ]);
  } catch (err) {
    await unlinkCachedTarball(tag);
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
  // Drop cache entries for older tags now that we've successfully landed on
  // this one — the only tarball we still need is the one we just deployed
  // (kept in case the operator immediately re-runs the deploy).
  await pruneCacheExcept([tag]);
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
    process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!arch) {
    throw new Error(
      `Unsupported architecture for Bun release binary: ${process.arch}`
    );
  }

  return `dist/bun/dispatch-*-bun-${platform}-${arch}`;
}

async function assertCurrentReleaseBinary(job: ReleaseJob): Promise<void> {
  const globPattern = currentReleaseBinaryGlob();
  const result = await runCommand(
    "bash",
    [
      "-lc",
      `set -euo pipefail; shopt -s nullglob; matches=(${globPattern}); if [ "\${#matches[@]}" -eq 0 ]; then exit 1; fi; printf '%s\n' "\${matches[0]}"`,
    ],
    { cwd: serverDir, allowedExitCodes: [0, 1] }
  );

  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new Error(
      `Expected compiled Bun binary matching ${globPattern} after deploy/build, but none was found`
    );
  }

  appendReleaseLog(job, `==> verified runtime binary ${result.stdout.trim()}`);
}

async function assertCommandOnPath(
  job: ReleaseJob,
  command: string,
  purpose: string
): Promise<void> {
  const quotedCommand = `'${command.replace(/'/g, `'\\''`)}'`;
  const result = await runCommand(
    "bash",
    ["-lc", `command -v -- ${quotedCommand} >/dev/null 2>&1`],
    { cwd: serverDir, allowedExitCodes: [0, 1] }
  );

  if (result.exitCode !== 0) {
    throw new Error(
      `${command} is required to ${purpose}, but was not found on PATH`
    );
  }

  appendReleaseLog(job, `==> found ${command} on PATH`);
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

    await assertCommandOnPath(job, "pnpm", "build Dispatch from source");

    appendReleaseLog(job, "==> installing dependencies");
    await streamProcess(
      "pnpm",
      ["install", "--frozen-lockfile"],
      { cwd: serverDir },
      job
    );

    appendReleaseLog(job, "==> building from source");
    await streamProcess("pnpm", ["run", "build:bun"], { cwd: serverDir }, job);
  }

  await assertCurrentReleaseBinary(job);

  // Write release record BEFORE the restart — after the restart our
  // process is dead and can't write anything.
  await writeReleaseStore({ tag, deployedAt: new Date().toISOString() });
  appendReleaseLog(job, `==> wrote release record for ${tag}`);

  // Tell SSE clients we're about to restart
  setReleasePhase(job, "restarting");
  appendReleaseLog(job, "==> restarting service");

  // Trigger the restart. On macOS, launchctl kickstart -k atomically kills
  // and restarts the service regardless of the launchd domain's on-demand
  // state (launchctl kill relies on KeepAlive, which doesn't fire when the
  // GUI domain is in on-demand-only mode and leaves the job pending).
  // On Linux, restart the user service directly. The UI health-poll takes
  // over from here.
  if (process.platform === "linux") {
    spawn("systemctl", ["--user", "restart", "dispatch"], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } else {
    const uid = process.getuid?.() ?? 501;
    spawn("launchctl", ["kickstart", "-k", `gui/${uid}/com.dispatch.server`], {
      detached: true,
      stdio: "ignore",
    }).unref();
  }
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
      throw new Error(
        "GitHub CLI (gh) is not available. Install it from https://cli.github.com"
      );
    }

    const repo = await getGitHubRepo();

    // Trigger workflow
    setReleasePhase(job, "triggering");
    appendReleaseLog(
      job,
      `==> triggering release workflow (version: ${job.versionType})`
    );

    try {
      await runCommand("gh", [
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

    // Give GitHub a moment to register the run
    await new Promise((r) => setTimeout(r, 3000));

    // Get the run ID
    const runIdResult = await runCommand("gh", [
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

    // Watch the workflow
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

    // Fetch tags and find the latest
    await runCommand("git", ["-C", serverDir, "fetch", "--tags", "--quiet"]);
    const tagsResult = await runCommand("git", [
      "-C",
      serverDir,
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
    resolveRepoRoot,
    resolveWorktreeRoot,
    mcpSendNotify,
    mcpUpsertEvent,
    mcpRenameSession,
    mcpShareMedia,
    mcpListMedia,
    mcpSubmitFeedback,
    mcpListPersonas,
    mcpLaunchPersona,
    mcpGetFeedback,
    mcpResolveFeedback,
    mcpSubmitResolution,
    mcpCancelRecheck,
    mcpUpsertPin,
    mcpDeletePin,
    mcpGetParentContext,
    mcpGetRecheckContext,
    mcpUpdateReviewStatus,
    mcpCompleteReview,
    mcpJobComplete,
    mcpJobFailed,
    mcpJobNeedsInput,
    mcpJobLog,
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
    pendingGitRefreshEnqueuedAt,
    gitRefreshDurationsMs,
    gitRefreshAgentDiagnostics,
    pendingGitRefreshAgentIds,
    activeGitRefreshAgentIds,
    gitRefreshCounters,
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
    loadScopedActivityEvents,
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
    getActiveReleaseJob: () => activeReleaseJob as RouteReleaseJob | null,
    setActiveReleaseJob: (job) => {
      activeReleaseJob = job as ReleaseJob | null;
    },
    getActiveAssistedUpdateLaunch: () => activeAssistedUpdateLaunch,
    setActiveAssistedUpdateLaunch: (active) => {
      activeAssistedUpdateLaunch = active;
    },
    releaseStreamClients,
    getAppVersionInfo,
    getGitHubRepo,
    parseGhJson,
    compareSemver,
    checkIsAdmin,
    fetchReleaseMetadata,
    fetchLatestReleaseMetadata,
    dispatchBaseUrl,
    dispatchHealthUrl,
    defaultServiceRestartCommand,
    buildAssistedUpdatePrompt,
    hasActiveAssistedUpdateAgent,
    broadcastReleaseEvent: (event) =>
      broadcastReleaseEvent(event as ReleaseStreamEvent),
    appendReleaseLog: (job, line) => appendReleaseLog(job as ReleaseJob, line),
    rehydrateActiveAssistedJob,
    runReleaseJob: (job) => runReleaseJob(job as ReleaseJob),
    runUpdateJob: (job) => runUpdateJob(job as ReleaseJob),
    getBearerToken,
    queueGitContextRefresh,
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
    queueGitContextRefresh,
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
        pendingGitRefreshAgentIds.delete(deletedId);
        pendingGitRefreshEnqueuedAt.delete(deletedId);
        activeGitRefreshAgentIds.delete(deletedId);
        gitRefreshAgentDiagnostics.delete(deletedId);
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
    resolveWorktreeRoot,
    resolveRepoRoot,
    mcpLaunchPersona,
    mcpCancelRecheck,
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
    await rehydrateActiveAssistedJob();
    const agents = await agentManager.listAgents();
    queueGitContextRefresh(agents.map((agent) => agent.id));
    startGitContextRefreshLoop();
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

function ensureGitRefreshAgentDiagnostics(agentId: string): {
  lastQueuedAt: number | null;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  lastDurationMs: number | null;
  lastResult:
    | "updated"
    | "unchanged"
    | "probe_error"
    | "failed"
    | "skipped"
    | null;
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
    lastError: null,
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
              pendingGitRefreshAgentIds.delete(deletedId);
              pendingGitRefreshEnqueuedAt.delete(deletedId);
              activeGitRefreshAgentIds.delete(deletedId);
              gitRefreshAgentDiagnostics.delete(deletedId);
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
    const nextAgentId = pendingGitRefreshAgentIds.values().next().value as
      | string
      | undefined;
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
        app.log.warn(
          { err: error, agentId: nextAgentId },
          "Git context refresh failed."
        );
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
    agent.gitContextStale ||
    !areGitContextsEqual(agent.gitContext, nextContext);

  await persistAgentGitContext(agentId, nextContext, false);
  if (!shouldPublish) {
    return "unchanged";
  }

  const refreshed = await agentManager.getAgent(agentId);
  if (refreshed) {
    uiEventBroker.publish({
      type: "agent.upsert",
      agent: withStreamFlag(refreshed),
    });
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
): Promise<
  { status: "ok"; value: AgentGitContext | null } | { status: "error" }
> {
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
          timeoutMs: PROBE_COMMAND_TIMEOUT_MS,
        })
      ).stdout
    );

    let branch = (
      await runCommand(
        "git",
        ["-C", cwd, "symbolic-ref", "--short", "-q", "HEAD"],
        {
          allowedExitCodes: [0, 1],
          timeoutMs: PROBE_COMMAND_TIMEOUT_MS,
        }
      )
    ).stdout;
    if (!branch) {
      branch = (
        await runCommand("git", ["-C", cwd, "rev-parse", "--short", "HEAD"], {
          allowedExitCodes: [0],
          timeoutMs: PROBE_COMMAND_TIMEOUT_MS,
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
        isWorktree: checkoutRoot !== repoRoot,
      },
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
  if (
    fallbackCommonDirResult.exitCode === 0 &&
    fallbackCommonDirResult.stdout
  ) {
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
        timeoutMs: PROBE_COMMAND_TIMEOUT_MS,
      })
    ).stdout
  );
}

async function resolveWorktreeRoot(cwd: string): Promise<string> {
  return normalizePath(
    (
      await runCommand("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
        allowedExitCodes: [0],
        timeoutMs: PROBE_COMMAND_TIMEOUT_MS,
      })
    ).stdout
  );
}

function mcpMethodNotAllowed(): {
  jsonrpc: "2.0";
  error: { code: number; message: string };
  id: null;
} {
  return {
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed.",
    },
    id: null,
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
        data: parsed.data,
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
        rows: parsed.rows,
      };
    }

    return null;
  } catch {
    return null;
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
  stopGitContextRefreshLoop();
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

function isAgentLatestEventType(value: unknown): value is AgentLatestEventType {
  return (
    typeof value === "string" &&
    AGENT_LATEST_EVENT_TYPES.includes(value as AgentLatestEventType)
  );
}

async function mcpUpsertEvent(
  agentId: string,
  event: { type: string; message: string; metadata?: Record<string, unknown> }
): Promise<void> {
  if (!isAgentLatestEventType(event.type)) {
    throw new Error(
      `type must be one of: ${AGENT_LATEST_EVENT_TYPES.join(", ")}.`
    );
  }
  const agent = await agentManager.upsertLatestEvent(agentId, {
    type: event.type,
    message: event.message.trim(),
    metadata: event.metadata,
  });
  uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(agent) });
}

async function mcpSendNotify(
  agentId: string,
  input: NotifyInput
): Promise<NotifyResult> {
  const agent = await agentManager.getAgent(agentId);
  if (!agent) throw new Error("Agent not found.");
  return slackNotifier.sendNotification(agent, input);
}

async function mcpSubmitFeedback(
  agentId: string,
  feedback: import("./agents/manager.js").FeedbackInput
): Promise<FeedbackRecord> {
  const record = await agentManager.submitFeedback(agentId, feedback);
  uiEventBroker.publish({
    type: "feedback.created",
    agentId,
    feedback: record,
  });
  return record;
}

async function mcpGetFeedback(
  agentId: string,
  opts: { persona?: string; limit?: number }
) {
  return agentManager.listFeedbackByParentGrouped(
    agentId,
    opts.persona,
    opts.limit
  );
}

async function mcpResolveFeedback(
  agentId: string,
  feedbackId: number,
  status: "fixed" | "ignored",
  options: { reason?: string | null } = {}
): Promise<import("./agents/manager.js").FeedbackRecord> {
  const parent = await agentManager.getAgent(agentId);
  const resolutionCommit = parent ? await resolveHeadSha(parent.cwd) : null;
  const record = await agentManager.updateFeedbackStatusByParent(
    feedbackId,
    agentId,
    status,
    { reason: options.reason ?? null, resolutionCommit }
  );
  if (!record)
    throw new Error(
      `Feedback #${feedbackId} not found or not owned by a child of this agent.`
    );
  uiEventBroker.publish({
    type: "feedback.updated",
    agentId: record.agentId,
    feedback: record,
  });
  return record;
}

async function mcpSubmitResolution(
  agentId: string,
  input: { personaAgentId: string; summary: string }
): Promise<{
  review: import("./agents/manager.js").PersonaReviewRecord;
  resolution: import("./agents/manager.js").PersonaReviewResolutionRecord;
}> {
  const parent = await agentManager.getAgent(agentId);
  if (!parent) throw new Error("Agent not found.");
  const resolutionCommit = await resolveHeadSha(parent.cwd);
  const result = await agentManager.submitReviewResolution({
    parentAgentId: agentId,
    personaAgentId: input.personaAgentId,
    summary: input.summary,
    resolutionCommit,
  });
  const [child, parentAgent] = await Promise.all([
    agentManager.getAgent(input.personaAgentId),
    agentManager.getAgent(agentId),
  ]);
  if (child)
    uiEventBroker.publish({
      type: "agent.upsert",
      agent: withStreamFlag(child),
    });
  if (parentAgent)
    uiEventBroker.publish({
      type: "agent.upsert",
      agent: withStreamFlag(parentAgent),
    });

  if (result.review.status === "awaiting_recheck" && child) {
    await injectTmuxPrompt(
      input.personaAgentId,
      buildReviewerRecheckReadyPrompt()
    );
  }

  return result;
}

async function mcpCancelRecheck(
  agentId: string,
  input: { personaAgentId: string; reason?: string }
): Promise<void> {
  const { review, transitioned } = await agentManager.cancelReviewRecheck({
    parentAgentId: agentId,
    personaAgentId: input.personaAgentId,
    reason: input.reason ?? null,
  });
  const [child, parent] = await Promise.all([
    agentManager.getAgent(input.personaAgentId),
    agentManager.getAgent(review.parentAgentId),
  ]);
  if (child) {
    uiEventBroker.publish({
      type: "agent.upsert",
      agent: withStreamFlag(child),
    });
  }
  if (parent) {
    uiEventBroker.publish({
      type: "agent.upsert",
      agent: withStreamFlag(parent),
    });
  }

  // Skip the inject when the review was already cancelled — calling cancel
  // twice should not double-prompt the reviewer.
  if (!transitioned) return;

  const reviewerPrompt = buildReviewerRecheckCancelledPrompt({
    reason: input.reason ?? null,
  });
  await injectTmuxPrompt(input.personaAgentId, reviewerPrompt);
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
    type: pin.type,
  });
  uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(agent) });
}

async function mcpDeletePin(agentId: string, label: string): Promise<void> {
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
  if (child)
    uiEventBroker.publish({
      type: "agent.upsert",
      agent: withStreamFlag(child),
    });
  if (parent)
    uiEventBroker.publish({
      type: "agent.upsert",
      agent: withStreamFlag(parent),
    });
}

async function mcpCompleteReview(
  agentId: string,
  input: {
    verdict: string;
    summary: string;
    filesReviewed?: string[];
    message?: string;
  }
): Promise<void> {
  const personaAgent = await agentManager.getAgent(agentId);
  const lastReviewedCommit = personaAgent
    ? await resolveHeadSha(personaAgent.cwd)
    : null;
  const review = await agentManager.completePersonaReview(agentId, {
    ...input,
    lastReviewedCommit,
  });
  const [child, parent] = await Promise.all([
    agentManager.getAgent(agentId),
    agentManager.getAgent(review.parentAgentId),
  ]);
  if (child)
    uiEventBroker.publish({
      type: "agent.upsert",
      agent: withStreamFlag(child),
    });
  if (parent)
    uiEventBroker.publish({
      type: "agent.upsert",
      agent: withStreamFlag(parent),
    });

  const feedbackCount = await agentManager.countFeedbackForAgent(agentId);
  const isMidRoundTrip = review.allowRecheck && review.roundNumber < 2;
  const parentPrompt = isMidRoundTrip
    ? buildParentRound1FeedbackPrompt({
        persona: review.persona,
        personaAgentId: agentId,
        verdict: input.verdict,
        feedbackCount,
      })
    : buildParentReviewCompletePrompt({
        persona: review.persona,
        personaAgentId: agentId,
        verdict: input.verdict,
        summary: input.summary,
        feedbackCount,
        roundNumber: review.roundNumber,
      });
  await injectTmuxPrompt(review.parentAgentId, parentPrompt);
}

async function mcpGetParentContext(
  parentAgentId: string
): Promise<import("./shared/mcp/server.js").ParentContextResult> {
  const parent = await agentManager.getAgent(parentAgentId);
  if (!parent) throw new Error("Parent agent not found.");

  const pins = (parent.pins ?? []).map((p) => ({
    label: p.label,
    value: p.value,
    type: p.type,
  }));

  const media = await agentManager.listMedia(parentAgentId);

  return {
    pins,
    media: media.map((m) => ({
      fileName: m.fileName,
      description: m.description,
      source: m.source,
      createdAt: m.createdAt,
    })),
  };
}

async function mcpGetRecheckContext(
  agentId: string
): Promise<import("./shared/mcp/server.js").RecheckContextResult | null> {
  const review = await agentManager.getPersonaReview(agentId);
  if (!review || !review.allowRecheck) {
    return null;
  }

  const resolution = (await agentManager.getReviewResolutions(review.id)).at(
    -1
  );
  const lastReviewedCommit = review.lastReviewedCommit;
  const resolutionCommit = resolution?.resolutionCommit ?? null;
  const resolutions = resolution
    ? await agentManager.listResolvedFeedbackForRound(
        agentId,
        resolution.roundNumber
      )
    : [];
  const availability =
    review.status === "cancelled"
      ? "cancelled"
      : review.status === "awaiting_recheck"
        ? "ready"
        : review.status === "complete" && review.roundNumber >= 2
          ? "complete"
          : "waiting_for_resolution";
  // Defense-in-depth: only emit a compare range if both commits look like git
  // SHAs. The reviewer is instructed to run `gitDiffCommand` locally, so the
  // string crosses a trust boundary into a CLI shell. Today these come from
  // `git rev-parse HEAD` and are 40-char hex, but validating here keeps that
  // contract auditable in one spot.
  const looksLikeSha = (value: string): boolean =>
    /^[0-9a-f]{4,64}$/i.test(value);
  const compareRange =
    availability === "ready" &&
    lastReviewedCommit &&
    resolutionCommit &&
    looksLikeSha(lastReviewedCommit) &&
    looksLikeSha(resolutionCommit)
      ? `${lastReviewedCommit}...${resolutionCommit}`
      : null;

  return {
    availability,
    reviewStatus: review.status,
    persona: review.persona,
    reviewId: review.id,
    reviewRoundNumber: review.roundNumber,
    resolutionRoundNumber: resolution?.roundNumber ?? null,
    resolutionSummary: resolution?.summary ?? null,
    lastReviewedCommit,
    resolutionCommit,
    compareRange,
    gitDiffCommand: compareRange ? `git diff ${compareRange}` : null,
    submittedAt: resolution?.submittedAt ?? null,
    resolutions,
  };
}

async function mcpRenameSession(
  agentId: string,
  name: string
): Promise<{ id: string; name: string }> {
  const agent = await agentManager.renameAgent(agentId, name);
  uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(agent) });
  return { id: agent.id, name: agent.name };
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

async function mcpJobComplete(
  agentId: string,
  report: unknown
): Promise<{ runId: string; status: string }> {
  const run = await jobService.completeRunForAgent(agentId, report);
  return { runId: run.id, status: run.status };
}

async function mcpJobFailed(
  agentId: string,
  report: unknown
): Promise<{ runId: string; status: string }> {
  const run = await jobService.failRunForAgent(agentId, report);
  return { runId: run.id, status: run.status };
}

async function mcpJobNeedsInput(
  agentId: string,
  question: string
): Promise<{ runId: string; status: string }> {
  const run = await jobService.markNeedsInputForAgent(agentId, question);
  return { runId: run.id, status: run.status };
}

async function mcpJobLog(
  agentId: string,
  input: {
    task: string;
    message: string;
    level: "debug" | "info" | "warn" | "error";
  }
): Promise<{ runId: string; status: string }> {
  const run = await jobService.logForAgent(agentId, input);
  return { runId: run.id, status: run.status };
}

async function mcpListPersonas(
  agentCwd: string
): Promise<Array<{ slug: string; name: string; description: string }>> {
  const personas = await loadPersonas(agentCwd);
  return personas.map(({ slug, name, description }) => ({
    slug,
    name,
    description,
  }));
}

async function mcpLaunchPersona(
  agentId: string,
  opts: {
    persona: string;
    context: string;
    agentType?: (typeof CLI_AGENT_TYPES)[number];
    allowRecheck?: boolean;
  }
): Promise<{ agentId: string; persona: string; parentAgentId: string }> {
  const parent = await agentManager.getAgent(agentId);
  if (!parent) throw new Error("Parent agent not found.");

  const fallbackReviewType = isCliAgentType(parent.reviewAgentType)
    ? parent.reviewAgentType
    : null;
  const fallbackParentType =
    parent.type === "claude" || parent.type === "opencode"
      ? parent.type
      : "codex";
  const personaAgentType: (typeof CLI_AGENT_TYPES)[number] =
    opts.agentType ?? fallbackReviewType ?? fallbackParentType;
  if (!CLI_AGENT_TYPES.includes(personaAgentType)) {
    throw new Error(`Unsupported persona agent type "${personaAgentType}".`);
  }

  const enabledAgentTypes = await getEnabledAgentTypes(pool);
  if (!enabledAgentTypes.includes(personaAgentType)) {
    throw new Error(`${personaAgentType} agents are disabled in settings.`);
  }

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
    throw new Error(
      `Persona "${opts.persona}" not found in .dispatch/personas/.`
    );
  }

  const diff = await buildPersonaReviewDiff(parentCwd, runCommand);

  const prompt = assemblePersonaPrompt(persona, opts.context, diff, {
    allowRecheck: opts.allowRecheck,
  });

  // Build agent args — include full access flag if parent has it
  const personaArgs: string[] = [`--append-system-prompt`, prompt];
  if (parent.fullAccess) {
    const fullAccessArg =
      personaAgentType === "claude"
        ? CLAUDE_FULL_ACCESS_ARG
        : personaAgentType === "codex"
          ? CODEX_FULL_ACCESS_ARG
          : null;
    if (fullAccessArg) personaArgs.push(fullAccessArg);
  }

  // For Claude persona agents, pre-assign a session ID so we know exactly which
  // session file belongs to this agent. buildAgentCommand handles adding the
  // --session-id flag; we just store it on the agent record here.
  const cliSessionId = personaAgentType === "claude" ? randomUUID() : undefined;

  const agent = await agentManager.createAgent({
    name: `${opts.persona}-${agentId.slice(-6)}`,
    type: personaAgentType,
    cwd: parentCwd,
    agentArgs: personaArgs,
    fullAccess: parent.fullAccess,
    useWorktree: false,
    persona: opts.persona,
    parentAgentId: agentId,
    personaContext: opts.context,
    cliSessionId,
    initialPrompt: buildPersonaKickoffPrompt(),
  });

  // Create the persona review record. Capture parent HEAD at launch time so
  // Phase 2 can diff round-1 findings against what the reviewer saw.
  const launchCommit = await resolveHeadSha(parentCwd);
  await agentManager.createPersonaReview({
    agentId: agent.id,
    parentAgentId: agentId,
    persona: opts.persona,
    lastReviewedCommit: launchCommit,
    allowRecheck: opts.allowRecheck,
  });

  // Re-fetch so the SSE event includes the review subquery data
  const agentWithReview = await agentManager.getAgent(agent.id);

  queueGitContextRefresh([agent.id]);
  uiEventBroker.publish({
    type: "agent.upsert",
    agent: withStreamFlag(agentWithReview ?? agent),
  });

  return { agentId: agent.id, persona: opts.persona, parentAgentId: agentId };
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

async function mcpShareMedia(
  agentId: string,
  opts: {
    filePath: string;
    description: string;
    source?: string;
    name?: string;
    update?: string;
  }
): Promise<{
  fileName: string;
  url: string;
  sizeBytes: number;
  source: string;
  description: string;
}> {
  const agent = await agentManager.getAgent(agentId);
  if (!agent) throw new Error("Agent not found.");

  if (!isMediaFile(opts.filePath)) {
    throw new Error(
      "Unsupported file type. Use images (png/jpg/gif/webp), video (mp4), documents (pdf), or text files (txt/md/json/yaml/ts/py/etc)."
    );
  }

  const isText = isTextFile(opts.filePath);
  const validSources = ["screenshot", "stream", "simulator", "text"];
  const source = isText
    ? "text"
    : opts.source && validSources.includes(opts.source)
      ? opts.source
      : "screenshot";

  const buffer = await readFile(opts.filePath);
  const mediaDir = resolveMediaDir(agentId, agent.mediaDir, config.mediaRoot);
  await mkdir(mediaDir, { recursive: true });

  // Update existing media file
  if (opts.update) {
    const existing = await pool.query<{ file_name: string }>(
      `SELECT file_name FROM media WHERE agent_id = $1 AND file_name = $2 FOR UPDATE`,
      [agentId, opts.update]
    );
    if (existing.rows.length === 0) {
      throw new Error(
        `No media file found with the given fileName for this agent.`
      );
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
      description: opts.description,
    };
  }

  // Create new media file
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "-")
    .replace("Z", "");
  const baseName = opts.name ?? path.basename(opts.filePath);
  const ext0 = path.extname(baseName).toLowerCase();
  const fallbackExt =
    ext0 === ".mp4" ? ".mp4" : isText ? ext0 || ".txt" : ".png";
  const safeName =
    baseName.replace(/ /g, "-").replace(/[^A-Za-z0-9._-]/g, "") ||
    `shared-${timestamp}${fallbackExt}`;
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
    description: opts.description,
  };
}

async function mcpListMedia(
  agentId: string,
  opts: { source?: string }
): Promise<
  Array<{
    fileName: string;
    filePath: string;
    source: string;
    description: string | null;
    sizeBytes: number;
    createdAt: string;
  }>
> {
  const agent = await agentManager.getAgent(agentId);
  if (!agent) throw new Error("Agent not found.");

  const mediaDir = resolveMediaDir(agentId, agent.mediaDir, config.mediaRoot);

  const whereClause = opts.source
    ? `WHERE agent_id = $1 AND source = $2`
    : `WHERE agent_id = $1`;
  const params: (string | number)[] = opts.source
    ? [agentId, opts.source]
    : [agentId];

  const result = await pool.query<{
    file_name: string;
    source: string;
    description: string | null;
    size_bytes: number;
    created_at: Date;
  }>(
    `SELECT file_name, source, description, size_bytes, created_at
     FROM media ${whereClause}
     ORDER BY created_at DESC LIMIT 100`,
    params
  );

  return result.rows.map((row) => ({
    fileName: row.file_name,
    filePath: path.join(mediaDir, row.file_name),
    source: row.source,
    description: row.description ?? null,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at.toISOString(),
  }));
}
