import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";
import type { AgentManager } from "../agents/manager.js";
import type { StreamService } from "../chat/service.js";
import type { loadConfig } from "../config.js";
import { resolveConfiguredPath } from "../shared/lib/resolve-tilde.js";
import { stateDir, statePath } from "../state-dir.js";
import {
  loadProbationConfig,
  resolveStatePaths,
} from "../update-recovery/control.js";
import { probeDatabase } from "../update-recovery/database-probe.js";
import {
  RecoveryMaintenance,
  type BusyReason,
} from "../update-recovery/maintenance.js";
import {
  takeResumeReceipt,
  writeResumeReceipt,
} from "../update-recovery/resume-receipt.js";

export function createUpdateRecoveryRuntime(deps: {
  pool: Pool;
  agentManager: AgentManager;
  streamService: Pick<StreamService, "inFlightDeliveryCount">;
  releaseRuntime: { hasActiveCreateJob(): boolean };
  config: Pick<
    ReturnType<typeof loadConfig>,
    "port" | "filesRoot" | "agentStateRoot"
  >;
  serverDir: string;
  version: string;
  log: FastifyBaseLogger;
  stopWriters(): Promise<void>;
  shutdown(code: number): Promise<void>;
  env?: NodeJS.ProcessEnv;
}) {
  const {
    pool,
    agentManager,
    streamService,
    releaseRuntime,
    config,
    serverDir,
    log,
  } = deps;
  const env = deps.env ?? process.env;
  const packageVersion = deps.version;
  // Update recovery: the independent helper fences this process before it stops
  // the service, and proves a probation start ready before it commits.
  const recoveryKeyFile = resolveConfiguredPath(
    env.DISPATCH_RECOVERY_KEY_FILE ??
      env.DISPATCH_RECOVERY_KEY_PATH ??
      statePath("update-recovery", "control.key")
  );
  const recoveryProbationFile = resolveConfiguredPath(
    env.DISPATCH_RECOVERY_PROBATION_FILE ??
      statePath("update-recovery", "probation.json")
  );
  const recoveryResumeFile = statePath("update-recovery", "resume-hosts.json");
  // Idle agents an update stopped, started once this process is listening.
  let pendingUpdateResumes: { id: string; updatedAt: string }[] = [];

  /** Agents from the fence's receipt whose rows are exactly as it left them. */
  async function takeUpdateResumes(): Promise<Set<string>> {
    let taken: Awaited<ReturnType<typeof takeResumeReceipt>>;
    try {
      taken = await takeResumeReceipt(recoveryResumeFile);
    } catch (err) {
      // Could not remove it durably: resume nothing rather than risk twice.
      log.error({ err }, "Could not take the update resume receipt");
      return new Set();
    }
    if (taken.status === "rejected") {
      log.warn(
        { reason: taken.reason },
        "Set aside an uncertain update resume receipt; no agents will be resumed"
      );
    }
    if (taken.status !== "ok") return new Set();
    const eligible = await agentManager.eligibleUpdateResumes(
      taken.receipt.agents
    );
    log.info(
      {
        transactionId: taken.receipt.transactionId,
        recorded: taken.receipt.agents.length,
        eligible: eligible.size,
      },
      "Read update resume receipt"
    );
    return eligible;
  }

  const ACTIVE_JOB_RUN_SQL = `SELECT count(*)::int AS count FROM job_runs
  WHERE status IN ('started', 'running')`;

  async function recoveryBusyReasons(): Promise<BusyReason[]> {
    const reasons: BusyReason[] = [];
    for (const agent of await agentManager.listAgents()) {
      if (["creating", "stopping", "archiving"].includes(agent.status)) {
        reasons.push({
          kind: "agent-transition",
          agentId: agent.id,
          detail: agent.status,
        });
      } else if (agentManager.isPromptHeld(agent.id)) {
        reasons.push({ kind: "agent-turn", agentId: agent.id });
      }
    }
    // Hosts outlive the service stop; one the server isn't attached to could
    // be mid-turn, so it defers the update like a busy one.
    const hosts = await agentManager.recoveryHostActivity();
    for (const agentId of hosts.busy)
      reasons.push({ kind: "host-busy", agentId });
    for (const agentId of hosts.unattached) {
      reasons.push({ kind: "host-unattached", agentId });
    }
    if (streamService.inFlightDeliveryCount > 0) {
      reasons.push({ kind: "chat-delivery" });
    }
    const runs = await pool.query<{ count: number }>(ACTIVE_JOB_RUN_SQL);
    if ((runs.rows[0]?.count ?? 0) > 0) {
      reasons.push({ kind: "job-run" });
    }
    // An active update job is the initiator of this fence, not competing work.
    if (releaseRuntime.hasActiveCreateJob()) {
      reasons.push({ kind: "release-job" });
    }
    return reasons;
  }

  const maintenance = new RecoveryMaintenance({
    version: packageVersion,
    instance: {
      instanceId:
        env.DISPATCH_INSTANCE_ID ?? env.DISPATCH_MAC_INSTANCE_ID ?? null,
      stateDir: stateDir(),
      port: config.port,
      macInstanceId: env.DISPATCH_MAC_INSTANCE_ID ?? null,
    },
    busyReasons: recoveryBusyReasons,
    stopWriters: deps.stopWriters,
    // Runtime-level stop keeps each agent row's running intent for the
    // backup; the next start settles those rows like any lost host.
    quiesceHosts: async (transactionId) => {
      const { stopped, remaining } =
        await agentManager.stopIdleHostsForRecovery(20_000);
      // Written before the helper backs up, so a restored backup carries
      // the same receipt and row timestamps as a committed update.
      try {
        await writeResumeReceipt(recoveryResumeFile, {
          formatVersion: 1,
          transactionId,
          createdAt: new Date().toISOString(),
          agents: await agentManager.updateResumeSnapshot(stopped),
        });
      } catch (err) {
        log.error({ err }, "Could not record agents to resume");
        return [{ kind: "resume-receipt" as const }];
      }
      return remaining.map((agentId) => ({
        kind: "host-still-running" as const,
        agentId,
      }));
    },
    probeDatabase: () => probeDatabase(pool),
    boundary: async () => {
      const liveHosts = await agentManager.listHostedAgentIds();
      return {
        hostsStopped: liveHosts.length === 0,
        liveHosts,
        // Durable stores this process writes; the release cache is
        // re-downloadable and left out.
        statePaths: await resolveStatePaths([
          stateDir(),
          serverDir,
          config.filesRoot,
          config.agentStateRoot,
          // Same resolution as release-store.ts / release-candidate-store.ts.
          resolveConfiguredPath(
            env.DISPATCH_RELEASE_STORE_PATH ?? statePath("release.json")
          ),
          resolveConfiguredPath(
            env.DISPATCH_RELEASE_CANDIDATE_STORE_PATH ??
              statePath("release-candidate.json")
          ),
        ]),
        macBuild: env.DISPATCH_MAC_BUILD ?? null,
      };
    },
    // Let the signed response flush before the graceful shutdown.
    exit: (code) => {
      setTimeout(() => {
        void deps
          .shutdown(code)
          .catch((err) => log.error({ err }, "Update recovery restart failed"));
      }, 250).unref?.();
    },
    log: log,
  });

  return {
    maintenance,
    routeDeps: {
      maintenance,
      keyFile: recoveryKeyFile,
      alternateKey: () => {
        const token = env.DISPATCH_MAC_APP_TOKEN;
        return env.DISPATCH_UPDATE_OWNER === "macos-app" &&
          token &&
          token.length >= 32
          ? token
          : null;
      },
    },
    async loadProbation() {
      const probation = await loadProbationConfig({
        env,
        controlFile: recoveryProbationFile,
        version: packageVersion,
      });
      if (probation && maintenance.mode !== "probation") {
        maintenance.enterProbation(probation);
        log.warn(
          { transactionId: probation.transactionId },
          "Starting in update recovery probation: reconciliation, schedulers and writes are suppressed"
        );
      }
    },
    async restoreAgents() {
      const updateResumes = await takeUpdateResumes();
      const { resumes } = await agentManager.restoreRunningAgents({
        resumeAfterUpdate: updateResumes,
      });
      pendingUpdateResumes = resumes;
    },
    resumePending() {
      const resumes = pendingUpdateResumes;
      pendingUpdateResumes = [];
      if (resumes.length > 0)
        void agentManager
          .resumeAgentsAfterUpdate(resumes)
          .then((resumed) =>
            log.info({ resumed }, "Resumed idle agents stopped for the update")
          )
          .catch((err) =>
            log.error({ err }, "Resuming agents after the update failed")
          );
    },
  };
}

/** Keeps the platform adapter outside the server composition root. */
export const protectedLinuxUpdate = async (
  input: Parameters<
    typeof import("../update-recovery/linux.js").applyProtectedLinuxUpdate
  >[0]
): Promise<void> => {
  const { applyProtectedLinuxUpdate } =
    await import("../update-recovery/linux.js");
  return applyProtectedLinuxUpdate(input);
};
