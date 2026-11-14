import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";

import type { AgentManager } from "../agents/manager.js";
import type { SlackNotifier } from "../notifications/slack.js";
import { type PresenceTracker, toastRecipients } from "../presence-tracker.js";
import type { UiEventBroker } from "./ui-events.js";

type CreateNotificationRuntimeDeps = {
  agentManager: AgentManager;
  slackNotifier: Pick<SlackNotifier, "shouldWebNotify">;
  presence: Pick<PresenceTracker, "activeSessions">;
  uiEventBroker: UiEventBroker;
  appLog: FastifyBaseLogger;
  webNotifyAckTimeoutMs: number;
  autoArchiveJobAgent: (agentId: string) => Promise<void>;
};

export function createNotificationRuntime(deps: CreateNotificationRuntimeDeps) {
  const {
    agentManager,
    slackNotifier,
    presence,
    uiEventBroker,
    appLog,
    webNotifyAckTimeoutMs,
    autoArchiveJobAgent,
  } = deps;

  const pendingWebNotifications = new Map<string, NodeJS.Timeout>();

  /** Questions and forms already toasted: one toast per item, ever. */
  const toastedBlocks = new Set<string>();

  agentManager.onAttention(({ agent, type, message, target }) => {
    const event = { type, message };
    // In the app: a toast on each active session not viewing the agent,
    // and no OS notification on any device.
    const sessions = presence.activeSessions();
    if (sessions.length > 0) {
      const recipients = toastRecipients(sessions, agent.id);
      if (recipients.length === 0) return;
      if (target) {
        if (toastedBlocks.has(target.blockId)) return;
        toastedBlocks.add(target.blockId);
        if (toastedBlocks.size > 1000) {
          const oldest = toastedBlocks.values().next().value;
          if (oldest !== undefined) toastedBlocks.delete(oldest);
        }
      }
      uiEventBroker.publishToSessions(
        {
          type: "attention.toast",
          toastId: target ? `block:${target.blockId}` : randomUUID(),
          agentId: agent.id,
          agentName: agent.name || agent.id.slice(0, 8),
          message,
          target: target ?? null,
        },
        recipients
      );
      return;
    }
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
