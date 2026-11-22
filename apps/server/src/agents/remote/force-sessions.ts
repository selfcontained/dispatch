import type { FastifyBaseLogger } from "fastify";

import type { RunnerResumeAgent } from "../../update-recovery/resume-receipt.js";
import type { PromptSource } from "../acp/prompt-source.js";
import type { StreamRecorder } from "../acp/stream-recorder.js";
import type { StreamStore, TurnPayload } from "../acp/stream-store.js";
import type { AgentRuntime, RunnerHostIdentity } from "../runtime.js";
import type { AgentRecord } from "../types.js";
import { remotePlacement } from "./protocol.js";

/*
 * Dispatch's policy for a forced runner update: which turns it cuts, and
 * what those agents are told afterwards. The coordinator decides when each
 * step runs and saves what it returns before the next one. The runner only
 * sees ordinary interrupt, stop, launch and prompt requests.
 */

export const UPDATE_CONTINUATION_MESSAGE =
  "Dispatch interrupted this turn to update the runner; the user did not interrupt it. Continue from where you left off.";

/** Stable across retries and restarts; the host claims each ID only once. */
export const continuationId = (attemptId: string, agentId: string) =>
  `runner-update:${attemptId}:${agentId}`;

/** How long one pass waits on a continuation before looking again. */
const DELIVERY_WAIT_MS = 1_000;

/** A turn that ended by itself, however late the interrupt, was not cut. */
function wasCut({ state, error, stopReason }: TurnPayload): boolean {
  return state === "settled" && (Boolean(error) || stopReason === "cancelled");
}

export class RunnerForceSessions {
  private readonly deliveries = new Map<string, Promise<boolean>>();

  constructor(
    private readonly deps: {
      runtime: AgentRuntime;
      recorder: Pick<StreamRecorder, "beginStop" | "settleStopped">;
      turns: Pick<StreamStore, "openTurn" | "turns">;
      getAgent(id: string): Promise<AgentRecord | null>;
      /** A user's stop or archive is under way. */
      leaving(id: string): boolean;
      rowClaims(ids: string[]): Promise<{ id: string; updatedAt: string }[]>;
      resolveSource(id: string, source: PromptSource): Promise<PromptSource>;
      streamChanged(id: string): void;
      logger: Pick<FastifyBaseLogger, "warn">;
    }
  ) {}

  hold(runnerId: string): void {
    this.deps.runtime.holdRunnerHosts?.(runnerId);
  }

  release(runnerId: string): void {
    this.deps.runtime.releaseRunnerHosts?.(runnerId);
  }

  /**
   * Every host's claim and open turn, before anything is destroyed. Null
   * while one cannot be told yet: a launch finishing, an attach replaying,
   * or a submitted turn that has not started. `final` stops waiting for the
   * last two and takes what Dispatch has recorded.
   */
  async snapshot(
    runnerId: string,
    hosts: { id: string; host?: RunnerHostIdentity }[],
    { epoch, final }: { epoch: number; final: boolean }
  ): Promise<RunnerResumeAgent[] | null> {
    const entries: RunnerResumeAgent[] = [];
    for (const { id, host } of hosts) {
      const agent = await this.agentOn(runnerId, id);
      if (agent?.status === "creating") return null;
      if (!this.resumable(agent)) continue;
      const attached = host?.attachedEpoch === epoch;
      if (!attached && !final) return null;
      const live = attached ? await this.deps.runtime.runnerTurn?.(id) : null;
      const row = await this.deps.turns.openTurn(id);
      if (live?.open && (live.seq === undefined || !row) && !final) return null;
      const [claim] = await this.deps.rowClaims([id]);
      if (!claim) continue;
      const open = row && (attached ? live?.open : true);
      entries.push({
        ...claim,
        ...(open && {
          turns: [
            {
              id: row.id,
              ...(live?.seq !== undefined && { seq: live.seq }),
            },
          ],
        }),
      });
    }
    return entries;
  }

  /** True once none of the snapshotted turns still runs. */
  async interrupt(entry: RunnerResumeAgent): Promise<boolean> {
    let settled = true;
    for (const { seq } of entry.turns ?? []) {
      if (seq === undefined) continue;
      // Whatever error the cut settles with is the stop, not a failure.
      this.deps.recorder.beginStop(entry.id);
      if (
        (await this.deps.runtime.interruptRunnerTurn?.(entry.id, seq)) === false
      )
        settled = false;
    }
    return settled;
  }

  /**
   * What to save before stopping this host. A turn that started since the
   * snapshot is cut by the stop. "wait" leaves a launch to finish; null is
   * a host to stop and not resume.
   */
  async prepareStop(
    runnerId: string,
    id: string,
    entry: RunnerResumeAgent | undefined
  ): Promise<RunnerResumeAgent | "wait" | null> {
    const agent = await this.agentOn(runnerId, id);
    if (agent?.status === "creating") return "wait";
    if (!this.resumable(agent)) return null;
    const live = await this.deps.runtime.runnerTurn?.(id);
    const row = await this.deps.turns.openTurn(id);
    const [claim] = await this.deps.rowClaims([id]);
    if (!claim) return null;
    const turns = [...(entry?.turns ?? [])];
    if (
      row &&
      (!live || live.open) &&
      !turns.some((turn) => turn.id === row.id)
    )
      turns.push({ id: row.id });
    return { ...claim, ...(turns.length && { turns: turns.slice(-16) }) };
  }

  /** Stops the host and returns its row's claim as the stop left it. */
  async stop(
    runnerId: string,
    id: string
  ): Promise<{ id: string; updatedAt: string } | undefined> {
    const { runtime, recorder } = this.deps;
    recorder.beginStop(id);
    await runtime.stopRunnerHost?.(runnerId, id);
    await recorder.settleStopped(id);
    this.deps.streamChanged(id);
    if (this.deps.leaving(id)) return undefined;
    return (await this.deps.rowClaims([id]))[0];
  }

  /**
   * Tell one resumed agent that its turn was cut, exactly once. "done" when
   * it was told, when nothing was cut, or when it is no longer wanted.
   * Never waits long: "waiting" is asked again on a later pass.
   */
  async continue(
    runnerId: string,
    attemptId: string,
    entry: RunnerResumeAgent,
    options: {
      /** An interrupt may still be settling. */
      settling: boolean;
      /** Saved before the first hand-off to the host. */
      markSent(): Promise<void>;
    }
  ): Promise<"done" | "waiting"> {
    const { runtime, turns } = this.deps;
    const { id } = entry;
    const wanted = async () => this.resumable(await this.agentOn(runnerId, id));
    if (!(await wanted())) return "done";
    const key = continuationId(attemptId, id);
    const delivering = this.deliveries.get(key);
    if (delivering) return this.delivered(delivering);
    if (!(await runtime.attach(id)))
      return (await runtime.runnerHostAlive?.(runnerId, id)) === false
        ? "done"
        : "waiting";
    await runtime.runnerTurn?.(id);
    const rows = await turns.turns(
      id,
      (entry.turns ?? []).map((turn) => turn.id)
    );
    const payloads = rows.map((row) => row.payload as unknown as TurnPayload);
    if (!entry.continuationSent && !payloads.some(wasCut))
      return options.settling &&
        payloads.some(({ state }) => state === "started")
        ? "waiting"
        : "done";

    const receipt = await runtime.promptReceipt?.(id, key);
    if (receipt === "accepted" || receipt === "claimed") return "done";
    if (receipt === undefined) return "waiting";
    // A host with no receipts gets it at most once.
    if (receipt === "unsupported" && entry.continuationSent) return "done";

    // Answered where the turn that was cut was answering.
    const conversation = payloads.find(wasCut)?.prompt?.conversation;
    const source = await this.deps.resolveSource(id, {
      source: "system",
      text: UPDATE_CONTINUATION_MESSAGE,
      ...(conversation && { conversation }),
    });
    const { accepted, settled } = runtime.prompt(
      id,
      UPDATE_CONTINUATION_MESSAGE,
      source,
      {
        continuationId: key,
        alone: true,
        delivery: "queue",
        beforeSubmit: async () => {
          if (!(await wanted())) return false;
          await options.markSent();
          return true;
        },
      }
    );
    settled.catch(() => {});
    const delivery = accepted
      .then(
        () => true,
        (err: unknown) => {
          this.deps.logger.warn(
            { err, agentId: id },
            "runner update continuation was not accepted"
          );
          return false;
        }
      )
      .finally(() => this.deliveries.delete(key));
    this.deliveries.set(key, delivery);
    return this.delivered(delivery);
  }

  private async delivered(delivery: Promise<boolean>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), DELIVERY_WAIT_MS);
    });
    try {
      return (await Promise.race([delivery, waited])) ? "done" : "waiting";
    } finally {
      clearTimeout(timer);
    }
  }

  private async agentOn(runnerId: string, id: string) {
    const agent = await this.deps.getAgent(id);
    return agent && remotePlacement(agent.cwd)?.runner === runnerId
      ? agent
      : null;
  }

  private resumable(agent: AgentRecord | null): boolean {
    return (
      agent?.status === "running" &&
      Boolean(agent.cliSessionId) &&
      !this.deps.leaving(agent.id)
    );
  }
}
