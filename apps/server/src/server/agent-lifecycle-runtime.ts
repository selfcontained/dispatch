import type { FastifyBaseLogger } from "fastify";

import type { ActivityMonitor } from "../agents/activity-monitor.js";
import type { AgentManager, AgentRecord } from "../agents/manager.js";
import type { StreamManager } from "../stream-manager.js";
import type { SubsystemTracker } from "../observability/subsystem-tracker.js";
import type { JobService } from "../jobs/service.js";
import type { PublishUiEvent } from "./ui-events.js";

type CreateAgentLifecycleRuntimeDeps = {
  agentManager: AgentManager;
  streamManager: StreamManager;
  appLog: FastifyBaseLogger;
  reconcileIntervalMs: number;
  activityMonitor?: ActivityMonitor;
  withStreamFlag: <T extends AgentRecord>(
    agent: T
  ) => T & { hasStream: boolean };
  publishUiEvent: PublishUiEvent;
  reconciliationTracker?: SubsystemTracker;
  activityTracker?: SubsystemTracker;
  onAgentsArchived?: (agentIds: string[]) => Promise<void>;
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

  async function notifyAgentsArchived(agentIds: string[]): Promise<void> {
    try {
      await deps.onAgentsArchived?.(agentIds);
    } catch (error) {
      appLog.error({ err: error, agentIds }, "Archive completion hook failed");
    }
  }

  return {
    /**
     * Claim an archive, then run its teardown in the background instead of
     * awaiting it. `startAfter` gates the teardown — the MCP archive tool uses
     * it to hold off until its response has been written, since an agent
     * archiving itself is the one waiting on that response.
     */
    async beginBackgroundArchive(
      agentId: string,
      cleanupWorktree: "auto" | "keep" | "force" = "auto",
      opts: { startAfter?: () => Promise<void> } = {}
    ): Promise<AgentRecord> {
      const agent = await agentManager.beginArchive(agentId, cleanupWorktree);
      publishUiEvent({ type: "agent.upsert", agent: withStreamFlag(agent) });
      trackArchive(
        agentId,
        (async () => {
          if (opts.startAfter) await opts.startAfter();
          await agentManager.executeArchive(agentId, {
            onPhaseChange: (updated) => {
              publishUiEvent({
                type: "agent.upsert",
                agent: withStreamFlag(updated),
              });
            },
            onComplete: (deletedIds) =>
              this.onArchivedAgentsDeleted(deletedIds),
            onError: (error) => this.onArchiveError(agentId, error),
          });
        })().catch((error) => this.onArchiveError(agentId, error))
      );
      return agent;
    },

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
            void notifyAgentsArchived(deletedIds);
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
      const reconciliationRun = deps.reconciliationTracker?.start();
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
                void notifyAgentsArchived(deletedIds);
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
        reconciliationRun?.succeed({ corrections: reconciled.length });
      } catch (error) {
        reconciliationRun?.fail(error);
        appLog.warn({ err: error }, "Agent status reconciliation failed.");
      }

      // Activity monitor: compare self-reported status against tmux pane
      // activity and auto-correct mismatches (runs on the same cadence).
      if (activityMonitor) {
        const activityRun = deps.activityTracker?.start();
        try {
          const result = await activityMonitor.check();
          activityRun?.succeed(result);
        } catch (error) {
          activityRun?.fail(error);
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
      void notifyAgentsArchived(deletedIds);
    },

    /** Restore durable continuation barriers after startup without polling. */
    async restorePendingContinuations(jobService: JobService): Promise<void> {
      // A reservation is already an active-run barrier. Recover it first so a
      // restart between successor row creation and agent attachment is prompt.
      for (const run of await jobService.listReservedContinuationRuns()) {
        try {
          await jobService.recoverReservedContinuation(run.id);
        } catch (err) {
          appLog.error(
            { err, runId: run.id },
            "Reserved continuation recovery failed"
          );
        }
      }
      for (const run of await jobService.listPendingContinuations()) {
        if (!run.agentId) {
          void jobService
            .launchPendingContinuation(run.id)
            .catch((err) =>
              appLog.error(
                { err, runId: run.id },
                "Restored continuation launch failed"
              )
            );
          continue;
        }
        const agent = await agentManager.getAgent(run.agentId);
        if (!agent) {
          void jobService
            .launchPendingContinuation(run.id)
            .catch((err) =>
              appLog.error(
                { err, runId: run.id },
                "Restored continuation launch failed"
              )
            );
          continue;
        }
        if (agent.status === "archiving") {
          if (!archivingAgentIds.has(agent.id)) {
            const archivePromise = agentManager.executeArchive(agent.id, {
              onPhaseChange: (updated) =>
                publishUiEvent({
                  type: "agent.upsert",
                  agent: withStreamFlag(updated),
                }),
              onComplete: (deletedIds) =>
                this.onArchivedAgentsDeleted(deletedIds),
              onError: (error) => this.onArchiveError(agent.id, error),
            });
            trackArchive(agent.id, archivePromise);
          }
          continue;
        }
        await this.autoArchiveJobAgent(agent.id);
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
