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
import { DshSupervisor } from "./agents/dsh/supervisor.js";
import type { AgentRecord } from "./agents/manager.js";
import {
  validateSession,
  getOrCreateAuthToken,
  getOrCreateCookieSecret,
  getReleaseUpdateAgentId,
  isScopedMcpRoute,
  LoginLinkStore,
  shouldAcceptApiBearerToken,
  validateAgentMcpToken,
  validateJobMcpToken,
} from "./auth.js";
import { loadConfig } from "./config.js";
import { createPool, createServiceResourcesProbePool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { deleteSetting, getSetting, setSetting } from "./db/settings.js";
import { runCommand } from "./shared/lib/run-command.js";
import { shouldSkipAutomaticMacPathProbe } from "./shared/mac-path-privacy.js";
import { mimeType, resolveMediaDir } from "./shared/media.js";
import { handleMcpRequest } from "./shared/mcp/server.js";
import { readReleaseStore, writeReleaseStore } from "./release-store.js";
import { promoteHealthyReleaseCandidate } from "./release-candidate-store.js";
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
import { CopyModeAssistManager } from "./terminal/copy-mode-assist-manager.js";
import { TerminalTokenStore } from "./terminal/token-store.js";
import { AGENT_TYPES, setEnabledAgentTypes } from "./agent-type-settings.js";
import { JobService } from "./jobs/service.js";
import { TemplateService } from "./templates/service.js";
import { ReleaseLogStreamProcessor } from "./release-log-stream.js";
import {
  packageVersion,
  staticFiles as embeddedStaticFiles,
} from "./generated/runtime-assets.js";
import { BrainStore } from "./brain/store.js";
import { registerActivityRoutes } from "./routes/activity/index.js";
import { registerAgentRoutes } from "./routes/agents/index.js";
import { registerBrainRoutes } from "./routes/brain.js";
import { registerBrowserExtensionRoutes } from "./routes/browser-extension.js";
import { MAX_STARTUP_FILE_COUNT } from "./routes/agent-startup.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerMessagesRoutes } from "./routes/messages.js";
import { registerChatRoutes } from "./routes/chat.js";
import { ChatService } from "./chat/service.js";
import { isChatSurfaceEnabled } from "./chat-surface-settings.js";
import { registerSurfaceRoutes } from "./routes/surfaces.js";
import { registerWhiteboardRoutes } from "./routes/whiteboard.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerPersonaRoutes } from "./routes/personas.js";
import { registerPersonalityRoutes } from "./routes/personalities.js";
import { registerReviewRoutes } from "./routes/reviews.js";
import { registerQuickPhraseRoutes } from "./routes/quick-phrases.js";
import { registerReleaseRoutes } from "./routes/release.js";
import { createAutoCheckRuntime } from "./release-auto-check.js";
import { registerStaticRoutes } from "./routes/static.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerPluginRoutes } from "./routes/plugin.js";
import { registerResourceRoutes } from "./routes/resources.js";
import { SurfaceService } from "./surfaces/service.js";
import {
  dateTruncTz,
  loadScopedActivityEvents,
  parseActivityQuery,
  timeRangeClause,
} from "./server/activity-query.js";
import { escapeLike } from "./shared/lib/escape-like.js";
import { createAgentLifecycleRuntime } from "./server/agent-lifecycle-runtime.js";
import { createPromptInjector } from "./server/agent-prompts.js";
import { InjectionCoordinator } from "./terminal/injection-coordinator.js";
import { MessageStore } from "./messages/store.js";
import {
  injectionHoldEnabled,
  loadInjectionHoldEnabled,
} from "./injection-hold-settings.js";
import { createAuthRuntime } from "./server/auth-runtime.js";
import { getBearerToken, handleAgentError } from "./server/http-helpers.js";
import {
  createReleaseRuntime,
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
import { createActivityMonitor } from "./agents/activity-monitor.js";
import { createAutoRenamePrompter } from "./agents/auto-rename-prompter.js";
import { DiffStatsRefresher } from "./agents/diff-stats-refresher.js";
import { SubsystemTracker } from "./observability/subsystem-tracker.js";
import {
  ServiceResources,
  type HttpRequestToken,
} from "./observability/service-resources.js";
import { readServiceResourcesCollectionEnabled } from "./observability/service-resources-settings.js";
import { resolveConfiguredPath } from "./shared/lib/resolve-tilde.js";

const config = loadConfig();
const app = Fastify({
  logger: true,
  ...(config.tls && { https: { cert: config.tls.cert, key: config.tls.key } }),
});
const pool = createPool(config);
const serviceResourcesProbePool = createServiceResourcesProbePool(config);
const agentManager = new AgentManager(pool, app.log, config);
const focusTracker = new FocusTracker();
const slackNotifier = new SlackNotifier(pool, app.log);
slackNotifier.setFocusCheck((agentId) => focusTracker.isFocused(agentId));
const uiEventBroker = new UiEventBroker();
const reconciliationTracker = new SubsystemTracker({
  id: "agent-reconciliation",
  label: "Agent reconciliation",
  description:
    "Checks running agent sessions and corrects stale lifecycle state.",
  expectedCadenceMs: 30_000,
});
const activityTracker = new SubsystemTracker({
  id: "activity-monitor",
  label: "Activity monitor",
  description: "Compares agent-reported state with recent terminal activity.",
  expectedCadenceMs: 30_000,
});
const gitRefreshTracker = new SubsystemTracker({
  id: "git-diff-refreshes",
  label: "Git diff refreshes",
  description:
    "Computes cached diff statistics when agent activity requests a refresh.",
});
const updateCheckTracker = new SubsystemTracker({
  id: "update-checker",
  label: "Update checker",
  description: "Checks the configured release channel for Dispatch updates.",
  expectedCadenceMs: 6 * 60 * 60 * 1000,
});
const diffStatsRefresher = new DiffStatsRefresher({
  getAgent: async (id) => {
    const agent = await agentManager.getAgent(id);
    if (!agent) return null;
    return {
      worktreePath: agent.worktreePath,
      cwd: agent.cwd,
      baseBranch: agent.baseBranch,
    };
  },
  publishEvent: (event) => uiEventBroker.publish(event),
  logger: app.log,
  tracker: gitRefreshTracker,
});
agentManager.attachDiffStatsRefresher(diffStatsRefresher);
const terminalTokenStore = new TerminalTokenStore(60_000);
const loginLinkStore = new LoginLinkStore();
const copyModeObserverManager = new CopyModeObserverManager((event) =>
  uiEventBroker.publish(event as UiEvent)
);
const copyModeAssistManager = new CopyModeAssistManager();
const jobService = new JobService(pool, agentManager, app.log, config);
const templateService = new TemplateService(pool, agentManager, app.log);
const jobNotifier = new JobNotifier(pool, app.log);
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
const AGENT_STATUS_RECONCILE_INTERVAL_MS = 30_000;

const ICON_COLOR_KEY = "icon_color";
const staticTheme = createStaticThemeRuntime(embeddedStaticFiles);

function withStreamFlag<T extends AgentRecord>(
  agent: T
): T & { hasStream: boolean } {
  return { ...agent, hasStream: streamManager.hasStream(agent.id) };
}

const serverDir = resolveConfiguredPath(
  process.env.DISPATCH_SERVER_DIR ??
    path.join(os.homedir(), ".dispatch", "server")
);
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
const autoCheckRuntime = createAutoCheckRuntime({
  pool,
  computeDeps: {
    pool,
    serverDir,
    getGitHubRepo: releaseRuntime.getGitHubRepo,
    compareSemver: releaseRuntime.compareSemver,
    fetchGitHubReleases: releaseRuntime.fetchGitHubReleases,
    getAppVersionInfo: async () => {
      const info = await releaseRuntime.getAppVersionInfo();
      return { version: info.version };
    },
    fetchLatestReleaseMetadata: releaseRuntime.fetchLatestReleaseMetadata,
  },
  isApplyInProgress: releaseRuntime.hasActiveUpdateJob,
  broadcast: (snapshot) => {
    uiEventBroker.publish({
      type: "release.cached_info_changed",
      snapshot,
    });
  },
  logger: app.log,
  tracker: updateCheckTracker,
});

const activityMonitor = createActivityMonitor({
  pool,
  logger: app.log,
  correctLatestEvent: async (id, expectedUpdatedAt, input) => {
    const agent = await agentManager.upsertLatestEventIfCurrent(
      id,
      expectedUpdatedAt,
      {
        ...input,
        metadata: { ...(input.metadata ?? {}), source: "activity-monitor" },
      }
    );
    return agent !== null;
  },
});
const agentLifecycleRuntime = createAgentLifecycleRuntime({
  agentManager,
  streamManager,
  appLog: app.log,
  reconcileIntervalMs: AGENT_STATUS_RECONCILE_INTERVAL_MS,
  activityMonitor,
  withStreamFlag,
  publishUiEvent: (event) => uiEventBroker.publish(event as UiEvent),
  reconciliationTracker,
  activityTracker,
  onAgentsArchived: async (agentIds) => {
    for (const agentId of agentIds) {
      const run = await jobService.getLatestRunForAgent(agentId);
      if (run?.continuationPending) {
        await jobService.launchPendingContinuation(run.id);
      }
    }
  },
});
const serviceResources = new ServiceResources({
  pool,
  probePool: serviceResourcesProbePool,
  listAgentSessions: async () => {
    const agents = await agentManager.listAgents();
    return agents
      .filter((agent) =>
        ["creating", "running", "stopping"].includes(agent.status)
      )
      .map((agent) => ({ tmuxSession: agent.tmuxSession }));
  },
  getWorkloads: () => {
    const streamMetrics = streamManager.getMetrics();
    const observerMetrics = copyModeObserverManager.getMetrics();
    const jobMetrics = jobService.getRuntimeMetrics();
    const gitMetrics = diffStatsRefresher.getMetrics();
    const uiMetrics = uiEventBroker.getMetrics();
    return {
      runningAgents: 0,
      sseClients: uiMetrics.clients,
      streams: streamMetrics.streams,
      streamViewers: streamMetrics.viewers,
      terminalObservers: observerMetrics.observers,
      terminalViewers: observerMetrics.viewers,
      scheduledJobs: jobMetrics.scheduledJobs,
      jobMonitors: jobMetrics.activeMonitors,
      gitRefreshesInFlight: gitMetrics.inFlight,
      uiEventsPublished: uiMetrics.eventsPublished,
      uiWriteFailures: uiMetrics.writeFailures,
      terminalPolls: observerMetrics.pollCount,
      terminalPollFailures: observerMetrics.pollFailures,
    };
  },
  subsystemTrackers: [
    reconciliationTracker,
    activityTracker,
    gitRefreshTracker,
    updateCheckTracker,
  ],
});
const resourceRequestStarts = new WeakMap<object, HttpRequestToken>();
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
void loadInjectionHoldEnabled(pool).catch((err) => {
  app.log.warn({ err }, "Failed to load injection-hold setting; default off");
});
const injectionCoordinator = new InjectionCoordinator({
  log: app.log,
  gateEnabled: injectionHoldEnabled,
  onHoldChange: (agentId, holdState) =>
    uiEventBroker.publish({
      type: "agent.injection_hold_changed",
      agentId,
      holdState,
    }),
});
const { injectAgentPrompt, enqueueAgentPrompt } = createPromptInjector(
  agentManager,
  app.log,
  injectionCoordinator
);
agentManager.onLatestEvent(
  createAutoRenamePrompter({ injectAgentPrompt, log: app.log })
);
agentManager.onAgentCreated((agent) => {
  uiEventBroker.publish({
    type: "agent.upsert",
    agent: withStreamFlag(agent),
  });
});
const authRuntime = createAuthRuntime({
  pool,
  sessionCleanupIntervalMs: 60 * 60 * 1000,
});
const brainStore = new BrainStore(pool);
const surfaceService = new SurfaceService(pool, {
  publishUiEvent: (event) => uiEventBroker.publish(event as UiEvent),
  sendAgentPrompt: injectAgentPrompt,
});
const chatService = new ChatService({
  pool,
  publishUiEvent: (event) => uiEventBroker.publish(event),
  getAgent: (agentId) => agentManager.getAgent(agentId),
  mediaRoot: config.mediaRoot,
  delivery: {
    access: (agentId) => agentManager.getTerminalAccess(agentId),
    // The service already checked deliverability; the injector re-resolves
    // the session itself, so a pane that vanished in between surfaces as a
    // failed delivery rather than a stale session name.
    inject: async (agentId, _sessionName, text) =>
      (await enqueueAgentPrompt(agentId, text)).delivery,
    held: (agentId) => injectionCoordinator.holdState(agentId).held,
  },
  log: app.log,
});
agentManager.attachLaunchContextRecorder(chatService);
const dshSupervisor = new DshSupervisor({
  pool,
  config,
  logger: app.log,
  getAgent: (agentId) => agentManager.getAgent(agentId),
  setCliSessionId: (agentId, sessionId) =>
    agentManager.setCliSessionId(agentId, sessionId),
  setLatestEvent: async (agentId, input) => {
    await agentManager.upsertLatestEvent(agentId, input);
  },
  publishChat: (agentId) => chatService.publishChanged(agentId),
  personaPromptFor: (agent) => agentManager.buildDshPersonaFor(agent),
});
agentManager.attachDshSupervisor(dshSupervisor);
jobService.setBrainStore(brainStore);
const mcpHandlers = createMcpHandlers({
  pool,
  mediaRoot: config.mediaRoot,
  agentManager,
  jobService,
  templateService,
  slackNotifier,
  publishUiEvent: (event) => uiEventBroker.publish(event as UiEvent),
  withStreamFlag,
  sendAgentPrompt: injectAgentPrompt,
  enqueueAgentPrompt,
  appLog: app.log,
  beginBackgroundArchive: (agentId, cleanupWorktree, opts) =>
    agentLifecycleRuntime.beginBackgroundArchive(
      agentId,
      cleanupWorktree,
      opts
    ),
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

  app.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/api/")) return;
    resourceRequestStarts.set(request, serviceResources.requestStarted());
  });
  const finishResourceRequest = (request: object, statusCode: number) => {
    const token = resourceRequestStarts.get(request);
    if (!token) return;
    serviceResources.requestFinished(token, statusCode);
    resourceRequestStarts.delete(request);
  };
  app.addHook("onResponse", async (request, reply) => {
    finishResourceRequest(request, reply.statusCode);
  });
  app.addHook("onRequestAbort", async (request) => {
    finishResourceRequest(request, 499);
  });
  app.addHook("onTimeout", async (request) => {
    finishResourceRequest(request, 504);
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
    if (url.startsWith("/api/v1/jobs/webhook/")) return;
    // Routes carrying this config enforce their own scoped extension bearer
    // token in a route-local preHandler. Keep them outside the general API
    // bearer shortcut so the server auth token is never accepted as an
    // extension credential.
    if (request.routeOptions.config.browserExtensionBearer) return;
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
    loginLinkStore,
  });

  await registerBrowserExtensionRoutes(app, {
    pool,
    agentManager,
    sendAgentPrompt: (agentId, prompt) =>
      injectAgentPrompt(agentId, prompt, { swallowFailure: false }),
    mediaRoot: config.mediaRoot,
    publishUiEvent: (event) => uiEventBroker.publish(event as UiEvent),
  });

  await registerJobRoutes(app, {
    jobService,
    publishUiEvent: (event) => uiEventBroker.publish(event as UiEvent),
  });

  await registerTemplateRoutes(app, {
    templateService,
    publishUiEvent: (event) => uiEventBroker.publish(event as UiEvent),
    withStreamFlag,
  });

  await registerMcpRoutes(app, {
    config,
    pool,
    loginLinkStore,
    agentManager,
    jobService,
    templateService,
    brainStore,
    publishBrainChanged: (repoRoot: string) =>
      uiEventBroker.publish({ type: "brain.changed", repoRoot }),
    publishUiEvent: (event) => uiEventBroker.publish(event),
    getBearerToken,
    validateJobMcpToken,
    validateAgentMcpToken,
    mcpSendNotify: mcpHandlers.sendNotify,
    mcpUpsertEvent: mcpHandlers.upsertEvent,
    mcpRenameSession: mcpHandlers.renameSession,
    mcpShareMedia: mcpHandlers.shareMedia,
    mcpListMedia: mcpHandlers.listMedia,
    mcpDeleteMedia: mcpHandlers.deleteMedia,
    mcpGetWhiteboard: mcpHandlers.getWhiteboard,
    mcpUpdateWhiteboard: mcpHandlers.updateWhiteboard,
    mcpClearWhiteboard: mcpHandlers.clearWhiteboard,
    mcpListPersonas: mcpHandlers.listPersonas,
    mcpLaunchPersona: mcpHandlers.launchPersona,
    mcpListPersonalities: mcpHandlers.listPersonalities,
    mcpCreatePersonality: mcpHandlers.createPersonality,
    mcpUpdatePersonality: mcpHandlers.updatePersonality,
    mcpDeletePersonality: mcpHandlers.deletePersonality,
    mcpSetActivePersonality: mcpHandlers.setActivePersonality,
    mcpClearActivePersonality: mcpHandlers.clearActivePersonality,
    mcpLaunchAgent: mcpHandlers.launchAgent,
    mcpArchiveAgent: mcpHandlers.archiveAgent,
    mcpResolveReviewFeedback: mcpHandlers.resolveReviewFeedback,
    mcpReopenReviewFeedback: mcpHandlers.reopenReviewFeedback,
    mcpSubmitReview: mcpHandlers.submitReview,
    mcpAddReviewFeedback: mcpHandlers.addReviewFeedback,
    mcpAddReviewThreadMessage: mcpHandlers.addReviewThreadMessage,
    mcpListReviewFeedback: mcpHandlers.listReviewFeedback,
    mcpGetReviewFeedbackItem: mcpHandlers.getReviewFeedbackItem,
    mcpSendMessage: mcpHandlers.sendMessage,
    mcpListAgentsForAgent: mcpHandlers.listAgentsForAgent,
    mcpUpsertPin: mcpHandlers.upsertPin,
    mcpUpsertPins: mcpHandlers.upsertPins,
    mcpDeletePin: mcpHandlers.deletePin,
    mcpDeletePinByLabel: mcpHandlers.deletePinByLabel,
    mcpListPins: mcpHandlers.listPins,
    mcpJobComplete: mcpHandlers.jobComplete,
    mcpJobFailed: mcpHandlers.jobFailed,
    mcpJobNeedsInput: mcpHandlers.jobNeedsInput,
    mcpJobLog: mcpHandlers.jobLog,
    mcpMethodNotAllowed,
    surfaces: surfaceService,
    chat: chatService,
  });

  await registerSystemRoutes(app, {
    pool,
    appLog: app.log,
    slackNotifier,
    iconColorKey: ICON_COLOR_KEY,
    validIconColors: VALID_ICON_COLORS,
    getCachedIconColor: staticTheme.getCachedIconColor,
    rewriteForColor: (color) => staticTheme.rewriteForColor(color as IconColor),
    publishUiEvent: (event) => uiEventBroker.publish(event as UiEvent),
  });
  await registerResourceRoutes(app, { pool, resources: serviceResources });

  await registerPluginRoutes(app, { pool, config, appLog: app.log });

  await registerBrainRoutes(app, {
    brainStore,
  });

  await registerActivityRoutes(app, {
    pool,
    agentManager,
    parseActivityQuery,
    loadScopedActivityEvents: (aq, opts) =>
      loadScopedActivityEvents(pool, aq, opts),
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
    getActiveCreateJob: releaseRuntime.getActiveCreateJob,
    setActiveCreateJob: releaseRuntime.setActiveCreateJob,
    getActiveUpdateJob: releaseRuntime.getActiveUpdateJob,
    setActiveUpdateJob: (job) => {
      // When an apply starts for the same tag the snapshot advertises,
      // clear the snapshot so the UI doesn't keep showing "vX available"
      // alongside the in-flight install.
      if (job && job.tag) {
        autoCheckRuntime.clearSnapshotIfMatchesTag(job.tag);
      }
      releaseRuntime.setActiveUpdateJob(job);
    },
    hasActiveCreateJob: releaseRuntime.hasActiveCreateJob,
    hasActiveUpdateJob: releaseRuntime.hasActiveUpdateJob,
    getActiveAssistedUpdateLaunch: releaseRuntime.getActiveAssistedUpdateLaunch,
    setActiveAssistedUpdateLaunch: releaseRuntime.setActiveAssistedUpdateLaunch,
    releaseCreateStreamClients: releaseRuntime.releaseCreateStreamClients,
    releaseUpdateStreamClients: releaseRuntime.releaseUpdateStreamClients,
    getAppVersionInfo: releaseRuntime.getAppVersionInfo,
    getGitHubRepo: releaseRuntime.getGitHubRepo,
    compareSemver: releaseRuntime.compareSemver,
    fetchGitHubReleases: releaseRuntime.fetchGitHubReleases,
    checkIsAdmin: releaseRuntime.checkIsAdmin,
    fetchReleaseMetadata: releaseRuntime.fetchReleaseMetadata,
    fetchLatestReleaseMetadata: releaseRuntime.fetchLatestReleaseMetadata,
    dispatchBaseUrl: releaseRuntime.dispatchBaseUrl,
    dispatchHealthUrl: releaseRuntime.dispatchHealthUrl,
    defaultServiceRestartCommand: releaseRuntime.defaultServiceRestartCommand,
    buildAssistedUpdatePrompt: releaseRuntime.buildAssistedUpdatePrompt,
    hasActiveAssistedUpdateAgent: releaseRuntime.hasActiveAssistedUpdateAgent,
    broadcastReleaseEvent: releaseRuntime.broadcastReleaseEvent,
    sendReleaseEventToClient: releaseRuntime.sendReleaseEventToClient,
    appendReleaseLog: releaseRuntime.appendReleaseLog,
    rehydrateActiveAssistedJob: releaseRuntime.rehydrateActiveAssistedJob,
    runReleaseJob: releaseRuntime.runReleaseJob,
    runUpdateJob: releaseRuntime.runUpdateJob,
    getBearerToken,
    publishUiEvent: (event) => uiEventBroker.publish(event as UiEvent),
    withStreamFlag,
    handleAgentError,
    autoCheck: autoCheckRuntime,
  });

  await registerMediaRoutes(app, {
    pool,
    mediaRoot: config.mediaRoot,
    agentManager,
    appLog: app.log,
    publishUiEvent: (event) => uiEventBroker.publish(event as UiEvent),
    injectionCoordinator,
  });

  await registerMessagesRoutes(app, {
    pool,
    publishUiEvent: (event) => uiEventBroker.publish(event as UiEvent),
  });

  await registerChatRoutes(app, { pool, chat: chatService, handleAgentError });

  await registerSurfaceRoutes(app, { surfaces: surfaceService });

  await registerWhiteboardRoutes(app, {
    pool,
    mediaRoot: config.mediaRoot,
    agentManager,
    publishUiEvent: (event) => uiEventBroker.publish(event as UiEvent),
  });

  await registerAgentRoutes(app, {
    pool,
    appLog: app.log,
    agentManager,
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
    copyModeAssistManager,
    injectionCoordinator,
    diffStatsRefresher,
    onArchivedAgentsDeleted: (deletedIds) =>
      agentLifecycleRuntime.onArchivedAgentsDeleted(deletedIds),
    onArchiveError: (agentId, error) =>
      agentLifecycleRuntime.onArchiveError(agentId, error),
    trackArchivePromise: (agentId, archivePromise) =>
      agentLifecycleRuntime.trackArchivePromise(agentId, archivePromise),
    sendAgentPrompt: (agentId, prompt) =>
      injectAgentPrompt(agentId, prompt, { swallowFailure: false }),
    onAgentStarted: (agentId) =>
      surfaceService.notifyQueuedAfterResume(agentId),
    chat: chatService,
    isChatSurfaceEnabled: () => isChatSurfaceEnabled(pool),
  });

  // --- Personas ---
  await registerPersonaRoutes(app, {
    agentManager,
    sendAgentPrompt: (agentId, prompt) =>
      injectAgentPrompt(agentId, prompt, { swallowFailure: false }),
    handleAgentError,
  });

  // --- Reviews ---

  await registerReviewRoutes(app, {
    pool,
    agentManager,
    publishUiEvent: (event) => uiEventBroker.publish(event as UiEvent),
    sendAgentPrompt: (agentId, prompt) =>
      injectAgentPrompt(agentId, prompt, { swallowFailure: false }),
    handleAgentError,
  });

  // --- Personalities ---

  await registerPersonalityRoutes(app, { pool });

  // --- Quick Phrases ---

  await registerQuickPhraseRoutes(app, { pool });
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
  serviceResources.setCollectionEnabled(
    await readServiceResourcesCollectionEnabled(pool)
  );
  const shouldReconcileState = options?.reconcileState ?? true;
  if (shouldReconcileState) {
    await agentManager.reconcileAgents();
    // Chat deliveries queued in the previous process died with it; flip their
    // rows from pending to not-delivered so the UI offers a resend.
    const recovered = await chatService.recoverPendingDeliveries();
    if (recovered.length > 0) {
      app.log.info(
        { agentIds: recovered },
        "Marked chat deliveries abandoned by the previous process as not delivered"
      );
    }
    // Same for cross-agent messages queued by dispatch_send_message.
    const staleMessages = await new MessageStore(pool).sweepPendingDeliveries();
    for (const pair of staleMessages) {
      uiEventBroker.publish({ type: "message.created", ...pair });
    }
    if (staleMessages.length > 0) {
      app.log.info(
        { pairs: staleMessages.length },
        "Marked agent messages abandoned by the previous process as not delivered"
      );
    }
    await agentLifecycleRuntime.restorePendingContinuations(jobService);
    await jobService.reconcileActiveRuns();
    await jobService.startSchedulers();
    // If we crashed/restarted mid-assisted-update, repopulate the
    // in-memory job from the on-disk state file so the operator UI
    // surfaces the in-flight phase right away.
    await releaseRuntime.rehydrateActiveAssistedJob();
    // Warm the diff-stats cache so the first sidebar expand doesn't get a
    // cold-cache `null`. Fire-and-forget per agent — the refresher's 3s
    // freshness window dedupes any overlap with SSE-driven signals from
    // agent activity that lands while warmup is still in flight.
    const agents = await agentManager.listAgents();
    for (const agent of agents) {
      void diffStatsRefresher.signal(agent.id);
    }
    agentLifecycleRuntime.startReconcileLoop();
    authRuntime.startSessionCleanupTimer();
    autoCheckRuntime.startScheduler();
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

  // The process that activated a new binary exits during the service restart,
  // so only this newly healthy process can truthfully promote the candidate.
  try {
    const promoted = await promoteHealthyReleaseCandidate({
      expectedTag: `v${packageVersion}`,
      writeReleaseStore,
    });
    if (promoted) app.log.info("Promoted healthy release candidate");
  } catch (err) {
    app.log.error({ err }, "Failed to promote healthy release candidate");
  }
}

export { app, shutdown };

let shuttingDown = false;
async function cleanupAppResources(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  streamManager.stopAll();
  agentLifecycleRuntime.stopReconcileLoop();
  authRuntime.stopSessionCleanupTimer();
  autoCheckRuntime.stopScheduler();
  await serviceResources.shutdown();

  notificationRuntime.clearPendingWebNotifications();

  await jobService.shutdown();
  await agentLifecycleRuntime.waitForActiveArchives(10_000);
  // Let deliveries that are about to settle record their outcome; anything
  // still waiting on the quiet gate is swept to not-delivered at next start.
  if (!(await chatService.waitForInFlightDeliveries(5_000))) {
    app.log.warn(
      { pending: chatService.inFlightDeliveryCount },
      "Shutting down with chat deliveries still in flight"
    );
  }

  await pool.end().catch(() => null);
  await app.close().catch(() => null);
}

async function shutdown(code: number): Promise<void> {
  await cleanupAppResources();
  process.exit(code);
}
