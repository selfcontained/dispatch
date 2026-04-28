import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";

import type { AgentManager, AgentRecord } from "../agents/manager.js";
import type { JobService } from "../jobs/service.js";
import type { SlackNotifier } from "../notifications/slack.js";
import type { UiEvent, UiEventBroker } from "./ui-events.js";

type CreateNotificationRuntimeDeps = {
  agentManager: AgentManager;
  jobService: JobService;
  slackNotifier: SlackNotifier;
  uiEventBroker: UiEventBroker;
  appLog: FastifyBaseLogger;
  webNotifyAckTimeoutMs: number;
  autoArchiveJobAgent: (agentId: string) => Promise<void>;
};

export function createNotificationRuntime(deps: CreateNotificationRuntimeDeps) {
  const {
    agentManager,
    jobService,
    slackNotifier,
    uiEventBroker,
    appLog,
    webNotifyAckTimeoutMs,
    autoArchiveJobAgent,
  } = deps;

  const pendingWebNotifications = new Map<string, NodeJS.Timeout>();

  agentManager.onLatestEvent((agent) => {
    const sendSlackNotification = async () => {
      if (!agent.name?.startsWith("job-")) {
        await slackNotifier.onAgentEvent(agent);
        return;
      }
      const run = await jobService.getLatestRunForAgent(agent.id);
      if (!run) {
        await slackNotifier.onAgentEvent(agent);
      }
    };

    void (async () => {
      try {
        const webPayload = await slackNotifier.shouldWebNotify(agent);
        if (webPayload && uiEventBroker.hasConnectedClient()) {
          const notificationId = randomUUID();
          uiEventBroker.publish({
            type: "notification",
            notificationId,
            ...webPayload,
          });

          const fallbackTimer = setTimeout(() => {
            pendingWebNotifications.delete(notificationId);
            appLog.debug(
              { notificationId, agentId: agent.id },
              "Web notification not acked — falling back to Slack"
            );
            void sendSlackNotification();
          }, webNotifyAckTimeoutMs);

          pendingWebNotifications.set(notificationId, fallbackTimer);
        } else {
          await sendSlackNotification();
        }
      } catch (err) {
        appLog.warn({ err, agentId: agent.id }, "Agent notification failed");
      }
    })();
  });

  return {
    ackWebNotification(notificationId: string): boolean {
      const timer = pendingWebNotifications.get(notificationId);
      if (!timer) return false;
      clearTimeout(timer);
      pendingWebNotifications.delete(notificationId);
      return true;
    },

    publishJobChanged(): void {
      uiEventBroker.publish({ type: "job.changed" });
    },

    async maybeAutoArchiveJobRun(
      run: {
        status: string;
        agentId: string | null;
        config?: { autoArchive?: boolean } | null;
      },
      terminalStatuses: Set<string>
    ): Promise<void> {
      const shouldAutoArchive = run.config?.autoArchive ?? true;
      if (
        terminalStatuses.has(run.status) &&
        run.agentId &&
        shouldAutoArchive
      ) {
        await autoArchiveJobAgent(run.agentId);
      }
    },

    clearPendingWebNotifications(): void {
      for (const timer of pendingWebNotifications.values()) {
        clearTimeout(timer);
      }
      pendingWebNotifications.clear();
    },
  };
}
