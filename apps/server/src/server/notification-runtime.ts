import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";

import type { AgentManager } from "../agents/manager.js";
import type { SlackNotifier } from "../notifications/slack.js";
import type { UiEventBroker } from "./ui-events.js";

type CreateNotificationRuntimeDeps = {
  agentManager: AgentManager;
  slackNotifier: SlackNotifier;
  uiEventBroker: UiEventBroker;
  appLog: FastifyBaseLogger;
  webNotifyAckTimeoutMs: number;
  autoArchiveJobAgent: (agentId: string) => Promise<void>;
};

export function createNotificationRuntime(deps: CreateNotificationRuntimeDeps) {
  const {
    agentManager,
    slackNotifier,
    uiEventBroker,
    appLog,
    webNotifyAckTimeoutMs,
    autoArchiveJobAgent,
  } = deps;

  const pendingWebNotifications = new Map<string, NodeJS.Timeout>();

  agentManager.onAttention(({ agent, type, message }) => {
    const event = { type, message };
    void (async () => {
      try {
        const webPayload = await slackNotifier.shouldWebNotify(agent, event);
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
              "Web notification not acked"
            );
          }, webNotifyAckTimeoutMs);

          pendingWebNotifications.set(notificationId, fallbackTimer);
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
        id?: string;
        status: string;
        agentId: string | null;
        continuationPending?: boolean;
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
