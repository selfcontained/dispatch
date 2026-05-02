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
import { existsSync, readFileSync } from "node:fs";

import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";
import * as z from "zod/v4";

import { AgentManager } from "./agents/manager.js";
import type { AgentRecord } from "./agents/manager.js";
import {
  validateSession,
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
import { mimeType, resolveMediaDir } from "./shared/media.js";
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
import { CopyModeObserverManager } from "./terminal/copy-mode-observer.js";
import { TerminalTokenStore } from "./terminal/token-store.js";
import { AGENT_TYPES, setEnabledAgentTypes } from "./agent-type-settings.js";
import { JobService } from "./jobs/service.js";
import { ReleaseLogStreamProcessor } from "./release-log-stream.js";
import {
  packageVersion,
  staticFiles as embeddedStaticFiles,
} from "./generated/runtime-assets.js";
import { registerActivityRoutes } from "./routes/activity.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { MAX_STARTUP_FILE_COUNT } from "./routes/agent-startup.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerFeedbackRoutes } from "./routes/feedback.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerPersonaReviewRoutes } from "./routes/persona-reviews.js";
import { registerPersonalityRoutes } from "./routes/personalities.js";
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
import { createAgentLifecycleRuntime } from "./server/agent-lifecycle-runtime.js";
import { createPromptInjector } from "./server/agent-prompts.js";
import { createAuthRuntime } from "./server/auth-runtime.js";
import {
  createGitContextRuntime,
  percentile,
  toIso,
} from "./server/git-context-runtime.js";
import { getBearerToken, handleAgentError } from "./server/http-helpers.js";
import {
  createReleaseRuntime,
  type ReleaseJob,
  RELEASE_VERSION_TYPES,
} from "./server/release-runtime.js";
import {
  createMcpHandlers,
  mcpMethodNotAllowed,
} from "./server/mcp-handlers.js";
import { createNotificationRuntime } from "./server/notification-runtime.js";
import {
  createStaticThemeRuntime,
  type IconColor,
  VALID_ICON_COLORS,
} from "./server/static-theme.js";
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
const copyModeObserverManager = new CopyModeObserverManager((event) =>
  uiEventBroker.publish(event as UiEvent)
);
let onCopyModeAssistDisabled = async () => {};
const registerCopyModeAssistDisableHandler = (handler: () => Promise<void>) => {
  onCopyModeAssistDisabled = handler;
};
const jobService = new JobService(pool, agentManager, app.log, config);
const jobNotifier = new JobNotifier(pool, app.log);

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

const ICON_COLOR_KEY = "icon_color";
const staticTheme = createStaticThemeRuntime(embeddedStaticFiles);

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
const agentLifecycleRuntime = createAgentLifecycleRuntime({
  agentManager,
  streamManager,
  appLog: app.log,
  reconcileIntervalMs: AGENT_STATUS_RECONCILE_INTERVAL_MS,
  withStreamFlag,
  publishUiEvent: (event) => uiEventBroker.publish(event as UiEvent),
  clearGitContextAgent: gitContextRuntime.clearAgent,
});
const notificationRuntime = createNotificationRuntime({
  agentManager,
  jobService,
  slackNotifier,
  uiEventBroker,
  appLog: app.log,
  webNotifyAckTimeoutMs: 3_000,
  autoArchiveJobAgent: (agentId) =>
    agentLifecycleRuntime.autoArchiveJobAgent(agentId),
});
const injectAgentPrompt = createPromptInjector(agentManager, app.log);
const authRuntime = createAuthRuntime({
  pool,
  sessionCleanupIntervalMs: 60 * 60 * 1000,
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
  sendAgentPrompt: injectAgentPrompt,
});
const jobTerminalStatuses = new Set([
  "completed",
  "failed",
  "timed_out",
  "crashed",
]);
jobService.onRunStateChange((run) => {
  notificationRuntime.publishJobChanged();
  void jobNotifier.onJobRunStateChange(run).catch((err) => {
    app.log.warn({ err, runId: run.id }, "Job run state notification failed");
  });
  void notificationRuntime
    .maybeAutoArchiveJobRun(run, jobTerminalStatuses)
    .catch((err) => {
      app.log.warn(
        { err, agentId: run.agentId },
        "Auto-archive of job agent failed"
      );
    });
});

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
    staticTheme.rewriteForColor(storedIconColor as IconColor);
  }

  await registerStaticRoutes(app, {
    getCachedIndexHtml: staticTheme.getCachedIndexHtml,
    getCachedManifest: staticTheme.getCachedManifest,
    staticAssets: staticTheme.staticAssets,
  });

  // Stamp every API response with the build-time package version so the
  // client can detect a server upgrade (e.g. after a self-update) and
  // surface a "reload" banner without polling a version endpoint.
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/")) {
      reply.header("X-Dispatch-Version", packageVersion);
    }
    return payload;
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
    if (!(await authRuntime.isPasswordSetCached())) return;

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
    isPasswordSetCached: () => authRuntime.isPasswordSetCached(),
    invalidatePasswordSetCache: () => authRuntime.invalidatePasswordSetCache(),
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
    getCachedIconColor: staticTheme.getCachedIconColor,
    rewriteForColor: (color) => staticTheme.rewriteForColor(color as IconColor),
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
    publishUiEvent: (event) => uiEventBroker.publish(event as UiEvent),
    onCopyModeAssistDisabled: () => onCopyModeAssistDisabled(),
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
    ackWebNotification: (notificationId) =>
      notificationRuntime.ackWebNotification(notificationId),
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
    copyModeObserverManager,
    registerCopyModeAssistDisableHandler,
    onArchivedAgentsDeleted: (deletedIds) =>
      agentLifecycleRuntime.onArchivedAgentsDeleted(deletedIds),
    onArchiveError: (agentId, error) =>
      agentLifecycleRuntime.onArchiveError(agentId, error),
    trackArchivePromise: (agentId, archivePromise) =>
      agentLifecycleRuntime.trackArchivePromise(agentId, archivePromise),
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
      injectAgentPrompt(agentId, prompt, { swallowFailure: false }),
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

  // --- Personalities ---

  await registerPersonalityRoutes(app, { pool });
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
    agentLifecycleRuntime.startReconcileLoop();
    authRuntime.startSessionCleanupTimer();
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

let shuttingDown = false;
async function cleanupAppResources(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  jobService.stopAllSchedulers();
  streamManager.stopAll();
  gitContextRuntime.stopLoop();
  agentLifecycleRuntime.stopReconcileLoop();
  authRuntime.stopSessionCleanupTimer();

  notificationRuntime.clearPendingWebNotifications();

  await agentLifecycleRuntime.waitForActiveArchives(10_000);

  await pool.end().catch(() => null);
  await app.close().catch(() => null);
}

async function shutdown(code: number): Promise<void> {
  await cleanupAppResources();
  process.exit(code);
}
