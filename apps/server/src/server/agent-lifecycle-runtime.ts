import type { FastifyBaseLogger } from "fastify";

import type { ActivityMonitor } from "../agents/activity-monitor.js";
import type { AgentManager, AgentRecord } from "../agents/manager.js";
import type { StreamManager } from "../stream-manager.js";

type CreateAgentLifecycleRuntimeDeps = {
  agentManager: AgentManager;
  streamManager: StreamManager;
  appLog: FastifyBaseLogger;
  reconcileIntervalMs: number;
  activityMonitor?: ActivityMonitor;
  withStreamFlag: <T extends AgentRecord>(
    agent: T
  ) => T & { hasStream: boolean };
  publishUiEvent: (event: unknown) => void;
};

export function createAgentLifecycleRuntime(
  deps: CreateAgentLifecycleRuntimeDeps
) {
  const {
    agentManager,
    streamManager,
    appLog,
    reconcileIntervalMs,
    activityMonitor,
    withStreamFlag,
    publishUiEvent,
  } = deps;

  const activeArchives = new Set<Promise<void>>();
  const archivingAgentIds = new Set<string>();
  let reconcileTimer: NodeJS.Timeout | null = null;

  function trackArchive(agentId: string, archivePromise: Promise<void>): void {
    archivingAgentIds.add(agentId);
    activeArchives.add(archivePromise);
    archivePromise.finally(() => {
      activeArchives.delete(archivePromise);
      archivingAgentIds.delete(agentId);
    });
  }

  return {
    async autoArchiveJobAgent(agentId: string): Promise<void> {
      if (archivingAgentIds.has(agentId)) return;
      try {
        const agent = await agentManager.beginArchive(agentId, "auto");
        publishUiEvent({
          type: "agent.upsert",
          agent: withStreamFlag(agent),
        });
        const archivePromise = agentManager.executeArchive(agentId, {
          onPhaseChange: (updated) => {
            publishUiEvent({
              type: "agent.upsert",
              agent: withStreamFlag(updated),
            });
          },
          onComplete: (deletedIds) => {
            for (const deletedId of deletedIds) {
              publishUiEvent({ type: "agent.deleted", agentId: deletedId });
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
        archivingAgentIds.add(agentId);
      } catch (err) {
        appLog.warn({ err, agentId }, "Auto-archive of job agent failed");
      }
    },

    startReconcileLoop(): void {
      if (reconcileTimer) {
        return;
      }
      reconcileTimer = setInterval(() => {
        void this.runAgentStatusReconciliation().catch((err) => {
          appLog.warn({ err }, "Agent status reconciliation failed");
        });
      }, reconcileIntervalMs);
    },

    stopReconcileLoop(): void {
      if (!reconcileTimer) {
        return;
      }
      clearInterval(reconcileTimer);
      reconcileTimer = null;
    },

    async runAgentStatusReconciliation(): Promise<void> {
      try {
        const reconciled = await agentManager.reconcileAgentStatuses();
        for (const agent of reconciled) {
          if (agent.status === "archiving") {
            if (archivingAgentIds.has(agent.id)) {
              continue;
            }
            appLog.info(
              { agentId: agent.id, agentName: agent.name },
              "Resuming interrupted archive"
            );
            publishUiEvent({
              type: "agent.upsert",
              agent: withStreamFlag(agent),
            });
            const archivePromise = agentManager.executeArchive(agent.id, {
              onPhaseChange: (updated) => {
                publishUiEvent({
                  type: "agent.upsert",
                  agent: withStreamFlag(updated),
                });
              },
              onComplete: (deletedIds) => {
                for (const deletedId of deletedIds) {
                  streamManager.stopStream(deletedId);
                  publishUiEvent({
                    type: "agent.deleted",
                    agentId: deletedId,
                  });
                }
              },
              onError: (error) => {
                appLog.error(
                  { err: error, agentId: agent.id },
                  "Resumed archive failed"
                );
              },
            });
            trackArchive(agent.id, archivePromise);
          } else {
            appLog.info(
              { agentId: agent.id, agentName: agent.name },
              "Agent status corrected to stopped"
            );
            publishUiEvent({
              type: "agent.upsert",
              agent: withStreamFlag(agent),
            });
          }
        }
      } catch (error) {
        appLog.warn({ err: error }, "Agent status reconciliation failed.");
      }

      // Activity monitor: compare self-reported status against tmux pane
      // activity and auto-correct mismatches (runs on the same cadence).
      if (activityMonitor) {
        try {
          await activityMonitor.check();
        } catch (error) {
          appLog.warn({ err: error }, "Activity monitor check failed.");
        }
      }
    },

    onArchivedAgentsDeleted(deletedIds: string[]): void {
      for (const deletedId of deletedIds) {
        streamManager.stopStream(deletedId);
        publishUiEvent({
          type: "agent.deleted",
          agentId: deletedId,
        });
      }
    },

    onArchiveError(agentId: string, error: unknown): void {
      appLog.error({ err: error, agentId }, "Background archive failed");
    },

    trackArchivePromise(agentId: string, archivePromise: Promise<void>): void {
      trackArchive(agentId, archivePromise);
    },

    async waitForActiveArchives(timeoutMs: number): Promise<void> {
      if (activeArchives.size === 0) {
        return;
      }
      appLog.info(
        { count: activeArchives.size },
        "Waiting for in-flight archives to complete…"
      );
      await Promise.race([
        Promise.allSettled(activeArchives),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    },
  };
}
