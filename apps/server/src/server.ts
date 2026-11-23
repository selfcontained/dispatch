import { localLaunchSettings } from "./agents/acp/launch-env.js";
import { enrolledRunnerId, isOnEnrolledRunner } from "./runners/placement.js";
import {
  localRunnerOf,
  startLocalRunnerProcess,
  type LocalRunnerProcess,
} from "./runners/local.js";
import { readLocalBindings } from "./runners/local-bindings.js";
import { embeddedBuild } from "./agents/build-identity.js";
import { CheckoutObservers } from "./agents/checkout-observers.js";
import { readAgentStats } from "./agents/checkout-runner.js";
import { discoverSlackLinkOrigins } from "./notifications/slack-link-origins.js";
import { QuestionAlerts } from "./notifications/question-alerts.js";
import { notifyForm } from "./notifications/notify-form.js";
import { SlackAnswers } from "./notifications/slack-answers.js";
import { SlackThreadReplies } from "./notifications/slack-thread-replies.js";
import { SteeringDecisions } from "./chat/steering-decisions.js";
import { RoutingSettings } from "./chat/routing-settings.js";
import { RoutingShadow, RoutingShadowStore } from "./chat/routing-shadow.js";
import { registerRoutingShadowRoutes } from "./routes/routing-shadow.js";
import { createRunnerPullRequestReader } from "./agents/pull-request-reader.js";
import { PullRequestRefresher } from "./agents/pull-request-refresher.js";
import { MergeRiskAssessor } from "./agents/merge-risk/assessor.js";
import {
  registerPortfolioBoundary,
  registerPortfolioRoutes,
} from "./routes/portfolio.js";
import { installRequestLifecycle } from "./server/request-lifecycle.js";
import { createCodexResetCoordinator } from "./agents/codex-reset.js";
import { createLocalEngineRunner } from "./agents/local-runner-engine.js";
import { TaskWatchNotifier } from "./tasks/watch-notifier.js";
import { UsageWatchService } from "./agents/usage-watches.js";
import { registerHumanTerminalRoutes } from "./routes/human-terminals.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { ScheduledMessageService } from "./scheduled-messages/service.js";
import { registerScheduledMessageRoutes } from "./routes/scheduled-messages.js";
import { agentForClient } from "./server/agent-client-view.js";
import path from "node:path";
import {
  listenAdditionalHosts,
  additionalListenerAddresses,
} from "./multi-listener.js";
import { watchLocalTls } from "./local-tls.js";
import { registerLocalTrustRoutes } from "./routes/local-trust.js";
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
import Fastify, { type FastifyRequest } from "fastify";
import {
  httpLoggingOptions,
  registerHttpLogging,
} from "./server/http-logging.js";
import * as z from "zod/v4";

import { AgentManager } from "./agents/manager.js";
import type { AgentRecord } from "./agents/manager.js";
import { agentTaskProject } from "./tasks/agent-scope.js";
import {
  validateSession,
  getOrCreateAuthToken,
  getOrCreateCookieSecret,
  sessionCookieName,
  isScopedMcpRoute,
  LoginLinkStore,
  shouldAcceptApiBearerToken,
  validateAgentMcpToken,
  validateJobMcpToken,
} from "./auth.js";
import { loadConfig } from "./config.js";
import { registerBrowserOriginProtection } from "./browser-origin.js";
import { createPool, createServiceResourcesProbePool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { loadLearnedAgentModels } from "./agents/engine-models.js";
import { loadModelAvailability } from "./agents/model-availability.js";
import { deleteSetting, getSetting, setSetting } from "./db/settings.js";
import { detectFileType } from "./files/file-type.js";
import { fileMetadataFromBuffer } from "./files/metadata.js";
import { runCommand } from "./shared/lib/run-command.js";
import { shouldSkipAutomaticMacPathProbe } from "./shared/mac-path-privacy.js";
import {
  MAX_ENCODED_FILE_NAME_LENGTH,
  resolveFilesDir,
  sanitizeUploadedFileName,
  timestampedFileName,
} from "./shared/files.js";
import { handleMcpRequest } from "./shared/mcp/server.js";
import { readReleaseStore, writeReleaseStore } from "./release-store.js";
import { promoteHealthyReleaseCandidate } from "./release-candidate-store.js";
import {
  ensureCachedTarball,
  pruneCacheExcept,
  unlinkCachedTarball,
} from "./release-tarball-cache.js";
import { StreamManager } from "./stream-manager.js";
import { SlackNotifier } from "./notifications/slack.js";
import { randomUUID } from "node:crypto";
import { JobNotifier } from "./notifications/job-notifier.js";
import { FocusTracker } from "./focus-tracker.js";
import { PresenceTracker, toastRecipients } from "./presence-tracker.js";
import { registerPresenceActivity } from "./server/presence-activity.js";
import { AGENT_TYPES, setEnabledAgentTypes } from "./agent-type-settings.js";
import { JobService } from "./jobs/service.js";
import { TemplateService } from "./templates/service.js";
import { ReleaseLogStreamProcessor } from "./release-log-stream.js";
import {
  buildRevision,
  gitSha,
  packageVersion,
  staticFiles as embeddedStaticFiles,
} from "./generated/runtime-assets.js";
import { BrainStore } from "./brain/store.js";
import { registerActivityRoutes } from "./routes/activity/index.js";
import { createProviderPlansReporter } from "./agents/provider-plans.js";
import { parseCodeowners } from "./personas/codeowners.js";
import { LEGACY_OWNERS_PATH, OWNERS_PATH } from "./personas/paths.js";
import { createMergeRiskGitHubSource } from "./agents/merge-risk/github-source.js";
import { RiskExplanations } from "./agents/merge-risk/explanations.js";
import { registerAgentRoutes } from "./routes/agents/index.js";
import { registerBrainRoutes } from "./routes/brain.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { TaskService } from "./tasks/service.js";
import { registerBrowserExtensionRoutes } from "./routes/browser-extension.js";
import { MAX_STARTUP_FILE_COUNT } from "./routes/agent-startup.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerStreamRoutes } from "./routes/streams.js";
import { StreamService, type TaskStreamRoot } from "./chat/service.js";
import { configuredRunner } from "./agents/remote/service.js";
import {
  fileRunnerHoldStore,
  RunnerUpdateHolds,
} from "./agents/remote/update-hold.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { backfillProjectRepositories } from "./projects/repository-backfill.js";
import { ProjectStore } from "./projects/store.js";
import { registerPersonaRoutes } from "./routes/personas.js";
import { registerPersonalityRoutes } from "./routes/personalities.js";
import { registerQuickPhraseRoutes } from "./routes/quick-phrases.js";
import { registerRunnerGitHub } from "./routes/runner-github.js";
import { registerRunnerInstaller } from "./routes/runner-installer.js";
import { registerRunnerArtifacts } from "./routes/runner-artifacts.js";
import {
  fileRunnerUpdateStore,
  RunnerUpdateCoordinator,
} from "./agents/remote/update-coordinator.js";
import type { RunnerArtifactSource } from "./server/runner-artifacts.js";
import { registerRunnerRepositorySearch } from "./routes/runner-repositories.js";
import { registerRunnerRoutes } from "./routes/runners.js";
import { registerReleaseRoutes } from "./routes/release.js";
import { registerMacAppRoutes } from "./routes/mac-app.js";
import { MacAppUpdateBridge } from "./mac-app-update-bridge.js";
import { isMacAppManaged } from "./update-owner.js";
import { createAutoCheckRuntime } from "./release-auto-check.js";
import { registerStaticRoutes } from "./routes/static.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerEngineLoginRoutes } from "./routes/engine-login.js";
import { registerEngineManagementRoutes } from "./routes/engine-management.js";
import { EngineLogins } from "./agents/engine-login.js";
import { engineStatuses } from "./agents/engine-availability.js";
import {
  EngineUpdateOperations,
  engineOperationStore,
} from "./agents/engine-updates.js";
import { EngineManager } from "./agents/remote/engine-manager.js";
import {
  remoteEngineTransport,
  runnerModelCatalogSource,
} from "./agents/remote/engine-transport.js";
import { setRunnerModelCatalogSource } from "./shared/agent-models.js";
import { registerPluginRoutes } from "./routes/plugin.js";
import { registerResourceRoutes } from "./routes/resources.js";
import {
  dateTruncTz,
  parseActivityQuery,
  timeRangeClause,
} from "./server/activity-query.js";
import { escapeLike } from "./shared/lib/escape-like.js";
import { createAgentLifecycleRuntime } from "./server/agent-lifecycle-runtime.js";
import { startRetentionSweep } from "./agents/retention.js";
import { createPromptInjector } from "./server/agent-prompts.js";
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
import { DiffStatsRefresher } from "./agents/diff-stats-refresher.js";
import { SubsystemTracker } from "./observability/subsystem-tracker.js";
import {
  ServiceResources,
  type HttpRequestToken,
} from "./observability/service-resources.js";
import { readServiceResourcesCollectionEnabled } from "./observability/service-resources-settings.js";
import { resolveConfiguredPath } from "./shared/lib/resolve-tilde.js";
import { stateDir, statePath } from "./state-dir.js";
import {
  createUpdateRecoveryRuntime,
  protectedLinuxUpdate,
} from "./server/update-recovery-runtime.js";
import { registerUpdateRecoveryRoutes } from "./routes/update-recovery.js";

const config = loadConfig();
const app = Fastify({
  routerOptions: { maxParamLength: MAX_ENCODED_FILE_NAME_LENGTH },
  ...httpLoggingOptions(),
  // Browser SSE requests stay active until we close them. The default only
  // closes idle connections, so app.close() can otherwise block an update.
  forceCloseConnections: true,
  ...(config.tls && { https: { cert: config.tls.cert, key: config.tls.key } }),
});
installRequestLifecycle(app, {
  started: (request) => {
    resourceRequestStarts.set(request, serviceResources.requestStarted());
  },
  finished: (request, statusCode) => {
    recoveryMaintenance.requestFinished(request);
    const token = resourceRequestStarts.get(request);
    if (!token) return;
    serviceResources.requestFinished(token, statusCode);
    resourceRequestStarts.delete(request);
  },
});
registerHttpLogging(app);
const pool = createPool(config);
const serviceResourcesProbePool = createServiceResourcesProbePool(config);
const routingSettings = new RoutingSettings(pool);
const steeringDecisions = new SteeringDecisions(pool, routingSettings);
const remoteRunner = configuredRunner({
  pool,
  host: config.listenHosts?.[0] ?? config.host,
  apiPort: config.port,
  apiTls: Boolean(config.tls),
  logger: app.log,
  // authToken is resolved at startup; read it per request.
  validAgentToken: (token, agentId) =>
    validateAgentMcpToken(config.authToken, token, agentId),
  validJobToken: (token, runId, agentId) =>
    validateJobMcpToken(config.authToken, token, runId, agentId),
});
const runnerEngines = remoteRunner
  ? remoteEngineTransport(remoteRunner, app.log)
  : undefined;
setRunnerModelCatalogSource(
  runnerEngines ? runnerModelCatalogSource(runnerEngines) : null,
  app.log
);
// Runner update holds: nothing is held until an update coordinator begins one.
const runnerHolds = remoteRunner
  ? new RunnerUpdateHolds({
      store: fileRunnerHoldStore(
        process.env.DISPATCH_RUNNER_HOLDS_PATH ??
          statePath("runner-update", "holds.json"),
        app.log
      ),
      logger: app.log,
    })
  : undefined;
const agentManager = new AgentManager(pool, app.log, config, {
  remote: remoteRunner,
  holds: runnerHolds,
  classifySteering: steeringDecisions.classify,
});
// Set with the routes that serve it; the coordinator reads it per request.
let runnerUpdateArtifacts: RunnerArtifactSource | undefined;
const runnerUpdates =
  remoteRunner && runnerHolds
    ? new RunnerUpdateCoordinator({
        service: remoteRunner,
        holds: runnerHolds,
        agents: agentManager,
        store: fileRunnerUpdateStore(
          process.env.DISPATCH_RUNNER_UPDATES_PATH ??
            statePath("runner-update", "attempts.json"),
          app.log
        ),
        artifacts: () => runnerUpdateArtifacts,
        build: { version: packageVersion, revision: buildRevision },
        logger: app.log,
      })
    : undefined;
const focusTracker = new FocusTracker();
const presenceTracker = new PresenceTracker();
const slackNotifier = new SlackNotifier(pool, app.log);
const slackAnswers = new SlackAnswers(
  pool,
  slackNotifier.app,
  () => streamService,
  async (agentId) => (await agentManager.getAgent(agentId))?.name ?? null,
  // A photo sent in a Slack thread becomes the agent's file, like an upload.
  async (agentId, name, bytes) => {
    const agent = await agentManager.getAgent(agentId);
    if (!agent) throw new Error("Agent not found.");
    const buffer = Buffer.from(bytes);
    const fileName = sanitizeUploadedFileName(path.basename(name));
    const type = detectFileType(buffer, fileName);
    if (!type.ok || type.media !== "image") throw new Error("Not an image.");
    const dir = resolveFilesDir(agent.id, agent.filesDir, config.filesRoot);
    await mkdir(dir, { recursive: true });
    // Slack names pasted images alike ("image.png"); never overwrite one.
    let stored = "";
    for (let n = 0; ; n++) {
      stored = timestampedFileName(fileName, new Date(), n ? `-${n}` : "");
      try {
        await writeFile(path.join(dir, stored), buffer, { flag: "wx" });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || n >= 20)
          throw error;
      }
    }
    try {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO files (agent_id, file_name, source, size_bytes, description, metadata, mime_type)
         VALUES ($1, $2, 'user', $3, $4, $5, $6) RETURNING id`,
        [
          agent.id,
          stored,
          buffer.length,
          "Sent from Slack",
          fileMetadataFromBuffer(buffer),
          type.mimeType,
        ]
      );
      return rows[0]!.id;
    } catch (error) {
      // Not recorded: don't leave the file behind.
      await unlink(path.join(dir, stored)).catch(() => {});
      throw error;
    }
  }
);
slackNotifier.setNotifySent((sent, agentId) =>
  slackAnswers.recordNotify(sent, agentId)
);
const slackThreadReplies: SlackThreadReplies = new SlackThreadReplies(
  pool,
  slackNotifier.app,
  slackAnswers,
  async (agentId) => (await agentManager.getAgent(agentId))?.name ?? null,
  (agentId) => streamService.currentTurn(agentId)
);
slackNotifier.setThreadReply((agent, input) =>
  slackThreadReplies.reply(agent, input)
);
slackNotifier.setTurnPost(
  async (agentId) =>
    (await slackThreadReplies.turnThread(agentId))?.target.postId ?? null
);
const questionAlerts = new QuestionAlerts(
  pool,
  (alert) => slackAnswers.postAsk(alert),
  async () => (await slackNotifier.app.settings()).binding,
  {
    now: Date.now,
    awaySince: () => presenceTracker.awaySince(),
    isViewing: (agentId) => presenceTracker.isViewing(agentId),
    timing: () => slackNotifier.alertTiming(),
  }
);
slackNotifier.setFormNotify((agent, input) =>
  notifyForm(
    {
      pool,
      post: (agentId, post, opts) => streamService.post(agentId, post, opts),
      alerts: questionAlerts,
      threads: slackThreadReplies,
    },
    agent,
    input
  )
);
slackNotifier.setFocusCheck((agentId) => focusTracker.isFocused(agentId));
const uiEventBroker = new UiEventBroker();
agentManager.onAttentionHistoryChanged(() =>
  uiEventBroker.publish({ type: "attention.history_changed" })
);
slackNotifier.setPresence({
  isPresent: () => presenceTracker.isPresent(),
  isViewing: (agentId) => presenceTracker.isViewing(agentId),
  showInApp: (agent, notice) =>
    uiEventBroker.publishToSessions(
      {
        type: "attention.toast",
        toastId: randomUUID(),
        agentId: agent.id,
        agentName: agent.name || agent.id.slice(0, 8),
        kind: "notice",
        message: notice.title
          ? `${notice.title}: ${notice.message}`
          : notice.message,
        target: null,
      },
      toastRecipients(presenceTracker.activeSessions(), agent.id)
    ),
});
const reconciliationTracker = new SubsystemTracker({
  id: "agent-reconciliation",
  label: "Agent reconciliation",
  description:
    "Checks running agent sessions and corrects stale lifecycle state.",
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
const mergeRiskGitHub = createMergeRiskGitHubSource(remoteRunner);
const mergeRiskAssessor = new MergeRiskAssessor({
  pool,
  github: mergeRiskGitHub,
  remoteOwners: async (id, runnerId) => {
    const agent = await agentManager.getAgent(id);
    if (!agent || !isOnEnrolledRunner(agent.placement, runnerId)) return null;
    for (const path of [OWNERS_PATH, LEGACY_OWNERS_PATH]) {
      const reply = await agentManager.inspectCheckout(agent, {
        kind: "readFile",
        path,
      });
      if (reply.kind === "readFile" && reply.content !== null)
        return parseCodeowners(reply.content, path);
    }
    return null;
  },
  settings: routingSettings,
  agentRoot: async (id) => {
    const agent = await agentManager.getAgent(id);
    return agent?.worktreePath ?? agent?.cwd ?? null;
  },
  warn: (error) => app.log.warn({ err: error }, "Merge-risk assessment failed"),
});
const pullRequests = new PullRequestRefresher({
  pool,
  remote: remoteRunner,
  listAgents: async () =>
    (await agentManager.listAgents()).map((agent) => ({
      id: agent.id,
      runnerId: enrolledRunnerId(agent.placement) ?? null,
    })),
  read: createRunnerPullRequestReader(
    remoteRunner,
    mergeRiskGitHub.nativeStatus
  ),
  publish: (event) => uiEventBroker.publish(event),
  assess: (url, value, owners, onProgress, runnerId) =>
    mergeRiskAssessor.assess(url, value, owners, onProgress, runnerId),
  notify: async (id, previous, current, commit) => {
    await streamService.pullRequestTransition(id, previous, current, commit);
  },
  notifyRisk: async (id, previous, current, commit) => {
    await streamService.pullRequestRiskChanged(id, previous, current, commit);
  },
  notifyChecks: async (id, previous, current, commit) => {
    await streamService.pullRequestChecksChanged(id, previous, current, commit);
  },
  warn: (error) => app.log.warn({ err: error }, "PR status refresh failed"),
});
remoteRunner?.onConnectionChange((id) => {
  pullRequests.invalidateRunner(id);
  if (remoteRunner.connectionEpoch(id) !== undefined)
    agentManager.retryStopsOnReconnect();
});
const diffStatsRefresher = new DiffStatsRefresher({
  getAgent: (id) => agentManager.getAgent(id),
  comparisonBase: (id, agent) =>
    agentManager.comparisonBase({ ...agent, id }, "changes"),
  computeAgentStats: (id, agent, base) =>
    readAgentStats(id, agent, agentManager.checkoutReadRunners(), base),
  publishEvent: (event) => uiEventBroker.publish(event),
  logger: app.log,
  tracker: gitRefreshTracker,
});
const checkoutObservers = new CheckoutObservers(
  () => agentManager.checkoutReadRunners(),
  (id) => {
    uiEventBroker.publish({ type: "agent.checkout_changed", agentId: id });
    void diffStatsRefresher.signal(id);
  }
);
agentManager.attachDiffStatsRefresher(diffStatsRefresher);
const loginLinkStore = new LoginLinkStore();
const jobService = new JobService(pool, agentManager, app.log, config);
const templateService = new TemplateService(pool, agentManager, app.log);
const jobNotifier = new JobNotifier(slackNotifier.app, app.log);
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

    const filesDir = resolveFilesDir(agentId, agent.filesDir, config.filesRoot);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `stream-capture-${timestamp}.jpg`;
    const type = detectFileType(lastFrame, fileName);
    if (!type.ok) return;

    await mkdir(filesDir, { recursive: true });
    await writeFile(path.join(filesDir, fileName), lastFrame);

    await pool.query(
      `INSERT INTO files (agent_id, file_name, source, size_bytes, description,
                          metadata, mime_type)
       VALUES ($1, $2, 'stream', $3, $4, $5, $6)`,
      [
        agentId,
        fileName,
        lastFrame.length,
        description,
        fileMetadataFromBuffer(lastFrame),
        type.mimeType,
      ]
    );

    uiEventBroker.publish({ type: "files.changed", agentId });
  }
);
const AGENT_STATUS_RECONCILE_INTERVAL_MS = 30_000;
let stopRetentionSweep: (() => void) | null = null;

const ICON_COLOR_KEY = "icon_color";
const staticTheme = createStaticThemeRuntime(embeddedStaticFiles);

function withStreamFlag<T extends AgentRecord>(
  agent: T
): T & { hasStream: boolean } {
  return agentForClient(agent, streamManager.hasStream(agent.id));
}

const serverDir = resolveConfiguredPath(
  process.env.DISPATCH_SERVER_DIR ?? statePath("server")
);
const releaseRuntime = createReleaseRuntime({
  serverDir,
  runCommand,
  readReleaseStore: () => readReleaseStore(),
  writeReleaseStore: (record) => writeReleaseStore(record),
  ensureCachedTarball,
  pruneCacheExcept,
  unlinkCachedTarball,
  createReleaseLogStreamProcessor: (sinks, onLine) =>
    new ReleaseLogStreamProcessor(sinks, onLine),
  // Linux updates always go through the independent recovery helper, which
  // fences this process over HTTP, stops the service and owns the commit.
  ...(process.platform === "linux"
    ? {
        applyProtectedUpdate: protectedLinuxUpdate,
      }
    : {}),
});
const autoCheckRuntime = createAutoCheckRuntime({
  pool,
  computeDeps: {
    pool,
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

const agentLifecycleRuntime = createAgentLifecycleRuntime({
  agentManager,
  streamManager,
  appLog: app.log,
  reconcileIntervalMs: AGENT_STATUS_RECONCILE_INTERVAL_MS,
  withStreamFlag,
  publishUiEvent: (event) => uiEventBroker.publish(event),
  reconciliationTracker,
  onAgentsArchived: async (agentIds) => {
    pullRequests.signal();
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
  artifactProbePool: createServiceResourcesProbePool(config),
  artifactRoots: [config.filesRoot, config.agentStateRoot],
  listAgentProcesses: async () => {
    const agents = await agentManager.listAgents();
    const running = agents.filter((agent) =>
      ["creating", "running", "stopping"].includes(agent.status)
    );
    return Promise.all(
      running.map(async (agent) => ({
        hostPid: await agentManager.hostPid(agent.id),
      }))
    );
  },
  getWorkloads: () => {
    const streamMetrics = streamManager.getMetrics();
    const jobMetrics = jobService.getRuntimeMetrics();
    const gitMetrics = diffStatsRefresher.getMetrics();
    const uiMetrics = uiEventBroker.getMetrics();
    return {
      runningAgents: 0,
      sseClients: uiMetrics.clients,
      streams: streamMetrics.streams,
      streamViewers: streamMetrics.viewers,
      scheduledJobs: jobMetrics.scheduledJobs,
      jobMonitors: jobMetrics.activeMonitors,
      gitRefreshesInFlight: gitMetrics.inFlight,
      uiEventsPublished: uiMetrics.eventsPublished,
      uiWriteFailures: uiMetrics.writeFailures,
    };
  },
  subsystemTrackers: [
    reconciliationTracker,
    gitRefreshTracker,
    updateCheckTracker,
  ],
});
const resourceRequestStarts = new WeakMap<object, HttpRequestToken>();
const notificationRuntime = createNotificationRuntime({
  agentManager,
  slackNotifier,
  presence: presenceTracker,
  uiEventBroker,
  appLog: app.log,
  webNotifyAckTimeoutMs: 3_000,
  autoArchiveJobAgent: (agentId) =>
    agentLifecycleRuntime.autoArchiveJobAgent(agentId),
});
const { injectAgentPrompt, enqueueAgentPrompt } = createPromptInjector(
  agentManager,
  app.log,
  (agentId, source) => streamService.resolvePromptSource(agentId, source)
);
// Status and phase changes the manager makes on its own (a detached launch
// coming up, an engine exiting, a restore at boot) reach the sidebar and the
// Chat presence line through the same upsert the routes publish.
agentManager.onAgentUpdated((agent) => {
  uiEventBroker.publish({ type: "agent.upsert", agent: withStreamFlag(agent) });
});
// A launched engine taught the server a new model list; open pickers refetch.
agentManager.onModelsLearned((agentType) => {
  uiEventBroker.publish({ type: "agent_models.changed", agentType });
});
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
const routingShadowStore = new RoutingShadowStore(pool, (agentId) => {
  uiEventBroker.publish({
    type: "routing.metadata_changed",
    streamId: agentId,
  });
});
const routingShadow = new RoutingShadow(
  () => routingSettings.configuration(),
  routingShadowStore,
  fetch,
  3000,
  (streamId, pending) =>
    uiEventBroker.publish({ type: "routing.pending", streamId, pending })
);
const streamService = new StreamService({
  routingShadow,
  onTaskActivity: (id) => taskWatches.schedule(id),
  pool,
  publishUiEvent: (event) => {
    uiEventBroker.publish(event);
    if (event.type === "stream.entry")
      pullRequests.observeBlock(event.entry.block);
    if (event.type === "stream.changed") pullRequests.signal();
  },
  hasUiClient: () => uiEventBroker.hasConnectedClient(),
  getAgent: (agentId) => agentManager.getAgent(agentId),
  filesRoot: config.filesRoot,
  onInputPosted: (agentId, text, block) =>
    agentManager.noteQuestionPosted(agentId, text, {
      streamId: block.streamId,
      threadId: block.threadId,
      blockId: block.id,
      kind: block.kind === "form" ? "form" : "question",
    }),
  onAgentAsk: (agentId, block): Promise<void> =>
    slackThreadReplies.agentAsked(agentId, block),
  // Both are created below; they are only called once requests arrive.
  uploadFile: (agentId, input) =>
    mcpHandlers.shareFile(agentId, {
      filePath: input.filePath,
      description: input.description,
    }),
  delivery: {
    access: (agentId) => agentManager.getTerminalAccess(agentId),
    inject: async (agentId, text, opts) =>
      (
        await enqueueAgentPrompt(agentId, text, {
          ...(opts?.source
            ? { source: opts.source }
            : opts?.blockId
              ? { source: { source: "chat", chatMessageId: opts.blockId } }
              : {}),
          ...(opts?.alone ? { alone: true } : {}),
          ...(opts?.images?.length ? { images: opts.images } : {}),
          ...(opts?.delivery ? { delivery: opts.delivery } : {}),
        })
      ).delivery,
    held: (agentId) => agentManager.isPromptHeld(agentId),
    activeTurn: (agentId) => agentManager.hasOpenTurn(agentId),
    updateHeld: (agentId) => agentManager.isUpdateHeld(agentId),
    cancel: (agentId) => {
      routingShadow.cancel(agentId);
      return agentManager.cancelTurn(agentId);
    },
    controlQueuedPrompt: (ids, blockId, action) =>
      agentManager.controlQueuedPrompt(ids, blockId, action),
    interruptDelivery: (ids, blockId) =>
      agentManager.interruptDelivery(ids, blockId),
    commands: (agentId) =>
      (agentManager.getCommands(agentId) ?? []).map((command) => command.name),
  },
  // Created below; only called once requests arrive.
  taskRoot: (taskId): Promise<TaskStreamRoot | null> =>
    taskService.streamRoot(taskId),
  // The same scope the agent's task tools use.
  agentProject: async (agentId) => {
    const agent = await agentManager.getAgent(agentId);
    if (!agent) return null;
    return agentTaskProject(agent, (input) =>
      taskService.projectForAgent(input)
    );
  },
  log: app.log,
});
const scheduledMessages = new ScheduledMessageService(
  pool,
  agentManager,
  streamService,
  app.log
);
agentManager.attachScheduleCancellation((id) =>
  scheduledMessages.cancelForAgent(id)
);
agentManager.attachLaunchContextRecorder(streamService);
agentManager.attachTurnBlocks({
  responseStarted: (input) => streamService.recordResponseStarted(input),
  responseSplit: (input) => streamService.recordResponseSplit(input),
  steering: async (event) => {
    await streamService.recordSteering(event);
    if (event.type === "steering_picked_up")
      await scheduledMessages.receipt(event);
  },
  started: (input) => streamService.recordTurnStarted(input),
  settled: (input) => streamService.recordTurnSettled(input),
});
// Every stream write re-publishes the agent's newest turn as one feed row.
agentManager.onStreamWrite((agentId) => {
  void streamService.publishTurnEntry(agentId);
});
jobService.setBrainStore(brainStore);
const taskService: TaskService = new TaskService({
  watches: {
    schedule: (id) => taskWatches.schedule(id),
    cancel: (id, agentId) => taskWatches.cancel(id, agentId),
  },
  pool,
  filesRoot: config.filesRoot,
  getAgent: (agentId) => agentManager.getAgent(agentId),
  getTemplate: (templateId) => templateService.getTemplate(templateId),
  launchTemplate: async (input) =>
    (await templateService.launchTemplate(input)).agent,
  chat: streamService,
  publishUiEvent: (event) => uiEventBroker.publish(event),
  log: app.log,
});
const taskWatches = new TaskWatchNotifier({
  pool,
  projectForAgent: async (id) => {
    const agent = await agentManager.getAgent(id);
    return agent
      ? agentTaskProject(agent, (input) => taskService.projectForAgent(input))
      : null;
  },
  deliver: async (agentId, text, options) => {
    await (
      await enqueueAgentPrompt(agentId, text, {
        source: { source: "system", text: "Task watch activity" },
        signal: options.signal,
        beforeSubmit: options.beforeSubmit,
      })
    ).delivery;
  },
  warn: (err) => app.log.warn({ err }, "task watch delivery deferred"),
});
agentManager.onAgentUpdated((agent) => {
  if (agent.status === "running" || agent.status === "archiving")
    void taskWatches
      .recover(agent.id)
      .catch((err) => app.log.warn({ err }, "task watch recovery failed"));
});
// Retry unavailable hosts and activity that was still inside the settle window.
const taskWatchRetry = setInterval(() => {
  void taskWatches
    .recover()
    .catch((err) => app.log.warn({ err }, "task watch retry failed"));
}, 30_000);
taskWatchRetry.unref();
app.addHook("onClose", async () => {
  clearInterval(taskWatchRetry);
  taskWatches.dispose();
});
const mcpHandlers = createMcpHandlers({
  pool,
  filesRoot: config.filesRoot,
  agentManager,
  jobService,
  templateService,
  slackNotifier,
  publishUiEvent: (event) => uiEventBroker.publish(event),
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

const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60; // 30 days

const updateRecoveryRuntime = createUpdateRecoveryRuntime({
  pool,
  agentManager,
  streamService,
  releaseRuntime,
  config,
  serverDir,
  version: packageVersion,
  log: app.log,
  shutdown,
  localRunner: () => localRunnerProcess,
  stopWriters: async () => {
    jobService.stopAllSchedulers();
    agentLifecycleRuntime.stopReconcileLoop();
    stopRetentionSweep?.();
    stopRetentionSweep = null;
    authRuntime.stopSessionCleanupTimer();
    autoCheckRuntime.stopScheduler();
    await pullRequests.stop();
    scheduledMessages.stop();
    streamManager.stopAll();
    await Promise.race([
      jobService.shutdown(),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    await agentLifecycleRuntime.waitForActiveArchives(10_000);
    await streamService.waitForInFlightDeliveries(5_000);
  },
});
const recoveryMaintenance = updateRecoveryRuntime.maintenance;

async function registerRoutes() {
  await routingSettings.configuration();
  const cookieSecret = await getOrCreateCookieSecret(pool);
  const SESSION_COOKIE = sessionCookieName(cookieSecret);
  await app.register(fastifyCookie, { secret: cookieSecret });
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 20 * 1024 * 1024,
      files: MAX_STARTUP_FILE_COUNT,
      fields: 24,
      parts: 32,
    },
  });
  await app.register(fastifyWebsocket, { options: { maxPayload: 16 * 1024 } });
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
  if (
    process.env.DISPATCH_LOCAL_TLS === "1" &&
    process.env.DISPATCH_UPDATE_OWNER === "macos-app"
  ) {
    await registerLocalTrustRoutes(app, statePath("tls"));
  }

  // Stamp every API response with the build-time package version so the
  // client can detect a server upgrade (e.g. after a self-update) and
  // surface a "reload" banner without polling a version endpoint.
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/")) {
      reply.header("X-Dispatch-Version", packageVersion);
    }
    return payload;
  });

  registerPresenceActivity(app, presenceTracker);

  // Update recovery gate: synchronous, ahead of auth, so nothing a fence or
  // probation excludes can reach a handler.
  app.addHook("onRequest", async (request, reply) => {
    const refused = recoveryMaintenance.admit(request);
    if (refused) {
      return reply.code(refused.status).header("Retry-After", "30").send({
        error: "Dispatch is in update maintenance.",
        code: refused.code,
      });
    }
    if (
      request.url.startsWith("/api/") &&
      !request.routeOptions.config.updateRecovery
    ) {
      recoveryMaintenance.requestStarted(request, request.method);
    }
  });

  const canManageEngineUpdates = async (
    request: FastifyRequest
  ): Promise<boolean> => {
    if (!(await authRuntime.isPasswordSetCached())) return true;
    const header = request.headers.authorization;
    if (
      header?.startsWith("Bearer ") &&
      shouldAcceptApiBearerToken(header.slice(7), config.authToken)
    )
      return true;
    const signed = request.cookies[SESSION_COOKIE];
    const unsigned = signed ? request.unsignCookie(signed) : null;
    return Boolean(
      unsigned?.valid &&
      unsigned.value &&
      (await validateSession(pool, unsigned.value))
    );
  };

  // ---------------------------------------------------------------------------
  // Auth hook — runs before every /api/ route except auth + health endpoints
  // ---------------------------------------------------------------------------
  registerBrowserOriginProtection(app, process.env.DISPATCH_ALLOWED_ORIGINS);
  registerPortfolioBoundary(app);
  app.addHook("onRequest", async (request, reply) => {
    // Authorize the matched route, not its potentially percent-encoded URL.
    // Keep the existing auth response for unmatched /api paths as well.
    const url = request.routeOptions.url ?? request.url.split("?")[0];

    // Static files, auth endpoints, health check, and WebSocket endpoints are always open.
    if (!url?.startsWith("/api/")) return;
    if (request.routeOptions.config.portfolioReader) return;
    if (url.startsWith("/api/v1/auth/")) return;
    if (url === "/api/v1/health") return;
    if (url === "/api/v1/app/branding") return;
    if (url.startsWith("/api/v1/jobs/webhook/")) return;
    // Routes carrying this config enforce their own scoped extension bearer
    // token in a route-local preHandler. Keep them outside the general API
    // bearer shortcut so the server auth token is never accepted as an
    // extension credential.
    if (request.routeOptions.config.browserExtensionBearer) return;
    // The menu app's control routes check its per-launch token themselves.
    if (request.routeOptions.config.macAppBearer) return;
    // Runner-initiated enrollment: the runner has no Dispatch credentials
    // until an operator approves it. These routes gate themselves with a
    // short, bounded-attempt code and a key-bound certificate; approval and
    // denial are ordinary authenticated routes alongside them.
    if (request.routeOptions.config.runnerConnectBootstrap) return;
    if (request.routeOptions.config.publicRunnerArtifact) return;
    // The recovery helper authenticates with its enrollment key, loopback-only.
    if (request.routeOptions.config.updateRecovery) return;
    const authHeader = request.headers.authorization;
    // Passwordless operator access follows the normal first-run policy.
    // Routes with this flag still validate explicitly supplied credentials.
    if (
      !(
        request.routeOptions.config.validateSuppliedAuthorization &&
        authHeader !== undefined
      ) &&
      !(await authRuntime.isPasswordSetCached())
    )
      return;

    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      if (shouldAcceptApiBearerToken(token, config.authToken)) {
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

  await registerHumanTerminalRoutes(app, {
    pool,
    sessionCookie: SESSION_COOKIE,
    getBackend: (id) => agentManager.terminalBackend(id),
  });

  await registerBrowserExtensionRoutes(app, {
    pool,
    agentManager,
    streamService,
    filesRoot: config.filesRoot,
    publishUiEvent: (event) => uiEventBroker.publish(event),
  });

  await registerJobRoutes(app, {
    jobService,
    publishUiEvent: (event) => uiEventBroker.publish(event),
  });

  await registerPortfolioRoutes(app, pool);
  await registerProjectRoutes(app, {
    pool,
    taskService,
    publishUiEvent: (event) => uiEventBroker.publish(event),
  });
  await registerTemplateRoutes(app, {
    templateService,
    publishUiEvent: (event) => uiEventBroker.publish(event),
    withStreamFlag,
  });

  const localEngines = createLocalEngineRunner({
    bins: { claude: config.claudeBin, codex: config.codexBin },
    logger: app.log,
  });
  const providerPlans = createProviderPlansReporter({
    load: localEngines.readProviderPlans,
    log: app.log,
  });
  const redeemCodexReset = createCodexResetCoordinator({
    providerPlans,
    consume: localEngines.consumeCodexReset,
  });
  // One evaluator for every agent's usage watches, fed by every refresh of
  // the shared reporter plus its own bounded tick while live watches exist.
  const usageWatches = new UsageWatchService({
    pool,
    providerPlans,
    deliver: async (agentId, text, options) => {
      await (
        await enqueueAgentPrompt(agentId, text, {
          source: { source: "system", text: "Usage watch" },
          signal: options.signal,
          beforeSubmit: options.beforeSubmit,
        })
      ).delivery;
    },
    warn: (err) => app.log.warn({ err }, "usage watch delivery deferred"),
  });
  const stopUsageReports = providerPlans.onReport((report) =>
    usageWatches.evaluate(report)
  );
  // Archived agents never claim a notice; the tick sweeps their rows.
  await usageWatches
    .recover()
    .catch((err) => app.log.warn({ err }, "usage watch recovery failed"));
  usageWatches.start();
  app.addHook("onClose", async () => {
    stopUsageReports();
    usageWatches.dispose();
  });
  await registerMcpRoutes(app, {
    localEngines,
    runnerEngines,
    usageWatches,
    providerPlans,
    redeemCodexReset,
    config,
    pool,
    loginLinkStore,
    agentManager,
    jobService,
    templateService,
    brainStore,
    publishBrainChanged: (repoRoot: string) =>
      uiEventBroker.publish({ type: "brain.changed", repoRoot }),
    taskService,
    publishUiEvent: (event) => uiEventBroker.publish(event),
    getBearerToken,
    validateJobMcpToken,
    validateAgentMcpToken,
    mcpSendNotify: mcpHandlers.sendNotify,
    mcpRenameSession: mcpHandlers.renameSession,
    mcpSetWorkspace: mcpHandlers.setWorkspace,
    mcpShareFile: mcpHandlers.shareFile,
    mcpListFiles: mcpHandlers.listFiles,
    mcpDeleteFile: mcpHandlers.deleteFile,
    mcpListPersonas: mcpHandlers.listPersonas,
    mcpLaunchOwnerReviews: mcpHandlers.launchOwnerReviews,
    mcpListPersonalities: mcpHandlers.listPersonalities,
    mcpCreatePersonality: mcpHandlers.createPersonality,
    mcpUpdatePersonality: mcpHandlers.updatePersonality,
    mcpDeletePersonality: mcpHandlers.deletePersonality,
    mcpSetActivePersonality: mcpHandlers.setActivePersonality,
    mcpClearActivePersonality: mcpHandlers.clearActivePersonality,
    mcpLaunchAgent: mcpHandlers.launchAgent,
    mcpArchiveAgent: mcpHandlers.archiveAgent,
    mcpListAgentsForAgent: mcpHandlers.listAgentsForAgent,
    pullRequests,
    riskEnabled: async () => {
      const settings = await routingSettings.configuration();
      return !!settings.mergeRiskEnabled && !!settings.apiKey;
    },
    mcpJobComplete: mcpHandlers.jobComplete,
    mcpJobFailed: mcpHandlers.jobFailed,
    mcpJobNeedsInput: mcpHandlers.jobNeedsInput,
    mcpJobLog: mcpHandlers.jobLog,
    mcpMethodNotAllowed,
    chat: streamService,
    scheduledMessages,
  });

  await registerScheduledMessageRoutes(app, scheduledMessages);
  // Shared with registerEngineManagementRoutes below: one login/update
  // tracker per process, so a scope-aware view (local or runner) and the
  // existing engine routes never diverge on the same in-flight state.
  const engineLogins = new EngineLogins({
    resolveBin: async (engine) =>
      (
        await engineStatuses({
          claude: config.claudeBin,
          codex: config.codexBin,
        })
      ).find((status) => status.id === engine)?.path ?? null,
  });
  const engineUpdates = new EngineUpdateOperations(engineOperationStore(pool), {
    onError: (error) =>
      app.log.error({ err: error }, "Engine update persistence failed"),
  });
  await registerSystemRoutes(app, {
    localEngines,
    engineUpdates,
    runnerBranches: remoteRunner?.listRepositoryBranches.bind(remoteRunner),
    publishModelsChanged: (agentType) =>
      uiEventBroker.publish({ type: "agent_models.changed", agentType }),
    slackAnswers,
    notificationLinkOrigins: () => {
      const primary = app.server.address();
      return discoverSlackLinkOrigins({
        addresses: [
          ...(primary && typeof primary !== "string" ? [primary] : []),
          ...additionalListenerAddresses(app),
        ],
        tls: !!config.tls,
        configuredHost: config.host,
      });
    },
    canManageEngineUpdates,
    pool,
    localCertificateTrust:
      process.env.DISPATCH_UPDATE_OWNER === "macos-app" &&
      process.env.DISPATCH_LOCAL_TLS === "1" &&
      config.tls !== null,
    appLog: app.log,
    slackNotifier,
    iconColorKey: ICON_COLOR_KEY,
    validIconColors: VALID_ICON_COLORS,
    getCachedIconColor: staticTheme.getCachedIconColor,
    rewriteForColor: (color) => staticTheme.rewriteForColor(color as IconColor),
    maintenanceMode: () => recoveryMaintenance.mode,
    engineBins: {
      claude: config.claudeBin,
      codex: config.codexBin,
      opencode: config.opencodeBin,
    },
  });
  await registerEngineLoginRoutes(app, engineLogins);
  await registerEngineManagementRoutes(
    app,
    new EngineManager({
      local: {
        logins: engineLogins,
        capabilities: localEngines,
        updates: engineUpdates,
        overrides: {
          claude: config.claudeBin,
          codex: config.codexBin,
          opencode: config.opencodeBin,
        },
      },
      remote: runnerEngines ?? {
        send: async () => ({
          ok: false,
          error: "Runner enrollment is disabled.",
          unsupported: true,
        }),
      },
    })
  );
  await registerUpdateRecoveryRoutes(app, updateRecoveryRuntime.routeDeps);
  await registerResourceRoutes(app, { pool, resources: serviceResources });
  await registerRoutingShadowRoutes(
    app,
    routingShadowStore,
    config.authToken,
    routingSettings,
    routingShadow,
    async (request) => {
      if (
        process.env.DISPATCH_DEV_STACK === "1" &&
        !(await authRuntime.isPasswordSetCached())
      )
        return true;
      const header = request.headers.authorization;
      if (
        header?.startsWith("Bearer ") &&
        shouldAcceptApiBearerToken(header.slice(7), config.authToken)
      )
        return true;
      return (
        (await authRuntime.isPasswordSetCached()) &&
        (await canManageEngineUpdates(request))
      );
    },
    (event) => uiEventBroker.publish(event),
    async () => {
      const config = await routingSettings.configuration();
      if (!config.mergeRiskEnabled || !config.apiKey) pullRequests.hideRisk();
      else pullRequests.allowRisk();
    }
  );
  const shadowRetention = setInterval(
    () => {
      void routingShadowStore.prune().catch(() => {});
      void steeringDecisions.prune().catch(() => {});
      void mergeRiskAssessor.prune().catch(() => {});
    },
    60 * 60 * 1000
  );
  shadowRetention.unref();
  app.addHook("onClose", async () => {
    clearInterval(shadowRetention);
  });

  await registerPluginRoutes(app, { pool, plugins: localEngines.plugins });

  await registerBrainRoutes(app, {
    brainStore,
  });

  await registerTaskRoutes(app, { taskService, withStreamFlag });

  await registerActivityRoutes(app, {
    pool,
    agentManager,
    parseActivityQuery,
    timeRangeClause,
    dateTruncTz,
    escapeLike,
  });

  const macAppControlToken = process.env.DISPATCH_MAC_APP_TOKEN;
  if (
    isMacAppManaged() &&
    macAppControlToken &&
    macAppControlToken.length >= 32
  ) {
    await registerMacAppRoutes(app, {
      bridge: new MacAppUpdateBridge((event) => uiEventBroker.publish(event)),
      controlToken: macAppControlToken,
    });
  }

  await registerReleaseRoutes(app, {
    pool,
    appLog: app.log,
    serverDir,
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
    releaseCreateStreamClients: releaseRuntime.releaseCreateStreamClients,
    releaseUpdateStreamClients: releaseRuntime.releaseUpdateStreamClients,
    getAppVersionInfo: releaseRuntime.getAppVersionInfo,
    getGitHubRepo: releaseRuntime.getGitHubRepo,
    compareSemver: releaseRuntime.compareSemver,
    fetchGitHubReleases: releaseRuntime.fetchGitHubReleases,
    checkIsAdmin: releaseRuntime.checkIsAdmin,
    fetchLatestReleaseMetadata: releaseRuntime.fetchLatestReleaseMetadata,
    broadcastReleaseEvent: releaseRuntime.broadcastReleaseEvent,
    sendReleaseEventToClient: releaseRuntime.sendReleaseEventToClient,
    runReleaseJob: releaseRuntime.runReleaseJob,
    runUpdateJob: releaseRuntime.runUpdateJob,
    autoCheck: autoCheckRuntime,
  });

  await registerFileRoutes(app, {
    pool,
    filesRoot: config.filesRoot,
    agentManager,
    appLog: app.log,
    publishUiEvent: (event) => uiEventBroker.publish(event),
  });

  await registerStreamRoutes(app, {
    pool,
    streams: streamService,
    handleAgentError,
    restartAgent: async (agentId) => {
      await agentManager.restartHost(agentId);
    },
  });

  await registerAgentRoutes(app, {
    localEngines,
    providerPlans,
    redeemCodexReset,
    tasks: {
      briefingFor: (taskId) => taskService.briefingFor(taskId),
      assignCreated: (taskId, agentId) =>
        taskService.assignCreated(taskId, agentId),
    },
    pool,
    appLog: app.log,
    agentManager,
    publishUiEvent: (event) => uiEventBroker.publish(event),
    subscribeUiEvents: (stream, sessionId) =>
      uiEventBroker.subscribe(stream, sessionId),
    sendUiSnapshot: (stream, agents) =>
      uiEventBroker.sendSnapshot(stream, agents),
    ackWebNotification: (notificationId) =>
      notificationRuntime.ackWebNotification(notificationId),
    clearFocusedAgents: () => focusTracker.clearAll(),
    setFocusedAgent: (agentId) => focusTracker.setFocused(agentId),
    reportPresence: (sessionId, beat) =>
      presenceTracker.heartbeat(sessionId, beat),
    withStreamFlag,
    handleAgentError,
    startStream: (agentId, port) => streamManager.startStream(agentId, port),
    stopStream: (agentId, description) =>
      streamManager.stopStream(agentId, description),
    hasStream: (agentId) => streamManager.hasStream(agentId),
    addStreamViewer: (agentId, stream) =>
      streamManager.addViewer(agentId, stream),
    diffStatsRefresher,
    observeCheckout: (agent) => checkoutObservers.observe(agent),
    pullRequests,
    riskExplanations: new RiskExplanations({
      pool,
      github: mergeRiskGitHub,
      settings: routingSettings,
    }),
    onArchivedAgentsDeleted: (deletedIds) =>
      agentLifecycleRuntime.onArchivedAgentsDeleted(deletedIds),
    onArchiveError: (agentId, error) =>
      agentLifecycleRuntime.onArchiveError(agentId, error),
    trackArchivePromise: (agentId, archivePromise) =>
      agentLifecycleRuntime.trackArchivePromise(agentId, archivePromise),
    sendAgentPrompt: (agentId, prompt) =>
      injectAgentPrompt(agentId, prompt, { swallowFailure: false }),
    chat: streamService,
  });

  // --- Personas ---
  await registerPersonaRoutes(app, {
    agentManager,
    projects: new ProjectStore(pool),
    streams: streamService,
    handleAgentError,
  });

  // --- Personalities ---

  await registerPersonalityRoutes(app, { pool });

  // --- Quick Phrases ---

  await registerQuickPhraseRoutes(app, { pool });
  const runnerArtifacts = registerRunnerArtifacts(app, {
    revision: gitSha,
    version: packageVersion,
    compiled: import.meta.url.startsWith("file:///$bunfs/root/"),
  });
  runnerUpdateArtifacts = runnerArtifacts;
  if (remoteRunner) {
    registerRunnerGitHub(app, remoteRunner, (id) =>
      pullRequests.invalidateRunner(id)
    );
    registerRunnerRepositorySearch(app, remoteRunner);
    registerRunnerInstaller(app, {
      runners: remoteRunner,
      artifacts: runnerArtifacts,
      build: { revision: gitSha, version: packageVersion },
    });
  }
  await registerRunnerRoutes(app, {
    runners: remoteRunner,
    updates: runnerUpdates,
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
  /**
   * Start the local runner child as `start` does, with this command instead
   * of this executable's own `local-runner` mode (an embedding without
   * `start`, such as a test harness).
   */
  localRunner?: { command: string[] };
}): Promise<typeof app> {
  // Read before the database is touched: invalid probation fails closed.
  await updateRecoveryRuntime.loadProbation();
  if (options?.localRunner && !localRunnerProcess)
    startLocalRunnerChild(options.localRunner.command);
  await agentManager.maintainServerLogs();
  await waitForDatabase();
  const shouldRunMigrations =
    options?.runMigrations ?? process.env.SKIP_MIGRATIONS !== "1";
  if (!shouldRunMigrations) {
    app.log.warn("SKIP_MIGRATIONS=1 — skipping database migrations");
  } else {
    await runMigrations();
    void backfillProjectRepositories(pool, app.log, () =>
      uiEventBroker.publish({ type: "project.changed" })
    );
  }
  config.authToken = await getOrCreateAuthToken(pool);
  // Enrolled runners reconnect before agents are restored and reconciled.
  try {
    await remoteRunner?.startEnrolled();
  } catch (error) {
    app.log.error({ err: error }, "Runner listener failed to start");
  }
  // The model lists engines published in earlier sessions, for the pickers.
  await loadLearnedAgentModels(pool);
  await loadModelAvailability(pool);
  serviceResources.setCollectionEnabled(
    await readServiceResourcesCollectionEnabled(pool)
  );
  // Held launches and the bound survive a restart; read them before agents
  // are restored so a held launch is not mistaken for a lost host.
  await runnerHolds?.load();
  await runnerUpdates?.load();
  // Probation never reconciles; only a normal start after commit does.
  const shouldReconcileState =
    recoveryMaintenance.mode !== "probation" &&
    (options?.reconcileState ?? true);
  if (shouldReconcileState) {
    // Hosts outlive the server: reconnect to the ones still running before
    // the reconciler decides anything about them.
    await updateRecoveryRuntime.restoreAgents();
    await agentManager.reconcileAgents();
    // Chat deliveries queued in the previous process died with it; flip their
    // rows from pending to not-delivered so the UI offers a resend.
    const recovered = await streamService.recoverPendingDeliveries();
    if (recovered.length > 0) {
      app.log.info(
        { agentIds: recovered },
        "Marked chat deliveries abandoned by the previous process as not delivered"
      );
    }
    await taskWatches.recover();
    await agentLifecycleRuntime.restorePendingContinuations(jobService);
    await jobService.reconcileActiveRuns();
    await jobService.startSchedulers();
    await scheduledMessages.start();
    // Arm each hold's bound only now: one that lapsed while Dispatch was down
    // releases its launches into a fully started service.
    runnerHolds?.start();
    await runnerUpdates?.start();
    // Warm the diff-stats cache so the first sidebar expand doesn't get a
    // cold-cache `null`. Fire-and-forget per agent — the refresher's 3s
    // freshness window dedupes any overlap with SSE-driven signals from
    // agent activity that lands while warmup is still in flight.
    const agents = await agentManager.listAgents();
    for (const agent of agents) {
      void diffStatsRefresher.signal(agent.id);
    }
    slackAnswers.start();
    void slackNotifier.app.start().catch(() => {});
    questionAlerts.start();
    pullRequests.start();
    agentLifecycleRuntime.startReconcileLoop();
    stopRetentionSweep = startRetentionSweep({
      pool,
      logger: app.log,
      filesRoot: config.filesRoot,
    });
    authRuntime.startSessionCleanupTimer();
    autoCheckRuntime.startScheduler();
  }
  if (!routesRegistered) {
    await registerRoutes();
    routesRegistered = true;
  }
  await app.ready();
  if (recoveryMaintenance.mode === "probation") {
    recoveryMaintenance.markProbationReady();
  }
  return app;
}

export async function closeApp(): Promise<void> {
  await cleanupAppResources();
}

let closeAdditionalListeners: (() => Promise<void>) | undefined;
let stopLocalTlsWatch: (() => void) | undefined;

let localRunnerProcess: LocalRunnerProcess | undefined;

/** Start and attach this app's local runner child; it prepares local launches. */
function startLocalRunnerChild(command?: string[]) {
  localRunnerProcess = startLocalRunnerProcess({
    stateRoot: config.agentStateRoot,
    filesRoot: config.filesRoot,
    launchEnvironment: JSON.stringify(localLaunchSettings(config)),
    build: embeddedBuild,
    log: app.log,
    frozen: updateRecoveryRuntime.localRunnerStartsFrozen(),
    bindings: () => readLocalBindings(pool),
    onReady: () => agentManager.retryStopsOnReconnect(),
    ...(command && { command }),
  });
  agentManager.attachLocalRunner(() => localRunnerOf(localRunnerProcess));
}

export async function start() {
  // Probation is known before the child starts, so a probation child starts
  // frozen and never serves a write before the update commits.
  await updateRecoveryRuntime.loadProbation();
  // Before agents are restored, probation included. Never awaited: the app
  // starts and works as before whether or not the child comes up.
  startLocalRunnerChild();
  await remoteRunner?.start();
  await initializeApp();

  const protocol = config.tls ? "https" : "http";
  await app.listen({
    host: config.host,
    port: config.port,
  });
  try {
    closeAdditionalListeners = await listenAdditionalHosts(
      app,
      config.listenHosts?.slice(1) ?? [],
      config.port,
      config.tls
    );
  } catch (error) {
    await app.close();
    throw error;
  }
  app.log.info(
    `Dispatch listening on ${protocol}://${config.host}:${config.port}`
  );
  if (process.env.DISPATCH_LOCAL_TLS === "1" && config.tls) {
    stopLocalTlsWatch = watchLocalTls({
      directory: statePath("tls"),
      hosts: config.listenHosts ?? [config.host],
      certificate: config.tls.cert,
      onRenewed: () => {
        // Bun's node:https implementation cannot reload a TLS context. The
        // supervisor restarts the worker; detached ACP hosts survive shutdown.
        app.log.info(
          "Renewed local HTTPS certificate; restarting the app-owned server to load it"
        );
        void shutdown(0).catch((err) =>
          app.log.error({ err }, "Certificate renewal restart failed")
        );
      },
      onError: (err) =>
        app.log.error(
          { err },
          "Could not renew local HTTPS certificate; retaining the current certificate"
        ),
    });
  }

  // In probation the recovery helper owns the commit; the normal start that
  // follows it promotes the candidate.
  if (recoveryMaintenance.mode === "probation") return;

  updateRecoveryRuntime.resumePending();

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
  checkoutObservers.close();
  remoteRunner?.close();
  runnerUpdates?.close();
  runnerHolds?.close();
  const stage = async (name: string, close: () => Promise<unknown>) => {
    app.log.info({ stage: name }, "Shutdown stage started");
    await close();
    app.log.info({ stage: name }, "Shutdown stage completed");
  };
  stopLocalTlsWatch?.();
  stopLocalTlsWatch = undefined;

  await stage("additional-listeners", async () => closeAdditionalListeners?.());
  closeAdditionalListeners = undefined;
  streamManager.stopAll();
  agentLifecycleRuntime.stopReconcileLoop();
  stopRetentionSweep?.();
  stopRetentionSweep = null;
  authRuntime.stopSessionCleanupTimer();
  autoCheckRuntime.stopScheduler();
  await pullRequests.stop();
  scheduledMessages.stop();
  await stage("service-resources", () => serviceResources.shutdown());

  questionAlerts.stop();
  slackAnswers.stop();
  slackNotifier.app.stop();
  notificationRuntime.clearPendingWebNotifications();

  await stage("jobs", () => jobService.shutdown());
  await stage("archives", () =>
    agentLifecycleRuntime.waitForActiveArchives(10_000)
  );
  // Let deliveries that are about to settle record their outcome; anything
  // still waiting on the quiet gate is swept to not-delivered at next start.
  if (!(await streamService.waitForInFlightDeliveries(5_000))) {
    app.log.warn(
      { pending: streamService.inFlightDeliveryCount },
      "Shutting down with chat deliveries still in flight"
    );
  }

  await stage("database", () => pool.end().catch(() => null));
  await stage("http", () => app.close().catch(() => null));
  // Closes the lifeline; detached hosts are untouched.
  await stage("local-runner", async () => localRunnerProcess?.stop());
  localRunnerProcess = undefined;
}

async function shutdown(code: number): Promise<void> {
  await cleanupAppResources();
  process.exit(code);
}
