import type { FastifyBaseLogger } from "fastify";

import type { AgentManager } from "../agents/manager.js";
import type { InjectionCoordinator } from "../terminal/injection-coordinator.js";
import { TmuxTerminal } from "../terminal/tmux-terminal.js";

/**
 * Enqueue a prompt for an agent's pane and return at once. Resolves once the
 * write is queued behind the coordinator (serialized per agent; behind the
 * quiet gate unless `gate: false`). Throws when the agent has no tmux session.
 * `delivery` settles when the pane write completes (or fails); `held` reports
 * whether the quiet gate is holding deliveries for this agent right now.
 */
export type EnqueueAgentPrompt = (
  agentId: string,
  prompt: string,
  opts?: { gate?: boolean }
) => Promise<{ held: boolean; delivery: Promise<void> }>;

export type InjectAgentPrompt = (
  agentId: string,
  prompt: string,
  opts?: { swallowFailure?: boolean; awaitDelivery?: boolean }
) => Promise<void>;

export function createPromptInjector(
  agentManager: AgentManager,
  appLog: FastifyBaseLogger,
  coordinator: InjectionCoordinator
): {
  enqueueAgentPrompt: EnqueueAgentPrompt;
  injectAgentPrompt: InjectAgentPrompt;
} {
  const enqueueAgentPrompt: EnqueueAgentPrompt = async (
    agentId,
    prompt,
    opts = {}
  ) => {
    const target = await agentManager.getPromptTarget(agentId);
    if (target.kind === "dsh") {
      // One turn at a time: a prompt that lands mid-turn is held until the
      // running turn settles, then delivered as the next turn. "Delivered"
      // means the turn started, which is what pane injection promises too.
      const { started, settled } = agentManager.promptDsh(agentId, prompt);
      settled.catch((error) => {
        appLog.warn({ err: error, agentId }, "dsh turn failed");
      });
      return { held: target.busy, delivery: started };
    }
    if (target.kind !== "tmux") {
      throw new Error(
        "Agent has no active terminal session — prompt cannot be delivered."
      );
    }
    const terminal = new TmuxTerminal(target.sessionName);
    const delivery = coordinator.inject(
      agentId,
      () => terminal.sendCommand(prompt),
      opts.gate === undefined ? {} : { gate: opts.gate }
    );
    return { held: coordinator.holdState(agentId).held, delivery };
  };

  /**
   * Fire-and-log wrapper over `enqueueAgentPrompt` for callers that only
   * need "best effort": failures are swallowed unless `swallowFailure` is
   * false, and `awaitDelivery: false` returns once the prompt is queued.
   */
  const injectAgentPrompt: InjectAgentPrompt = async (
    agentId,
    prompt,
    opts = {}
  ) => {
    try {
      let enqueued: Awaited<ReturnType<EnqueueAgentPrompt>>;
      try {
        enqueued = await enqueueAgentPrompt(agentId, prompt);
      } catch (error) {
        if (opts.swallowFailure === false) throw error;
        appLog.debug(
          { err: error, agentId },
          "Skipping tmux injection — agent has no tmux session"
        );
        return;
      }
      if (opts.awaitDelivery === false) {
        // Caller only needs enqueue confirmation (e.g. MCP tool calls that
        // would time out waiting for the quiet gate); FIFO delivery is
        // guaranteed by the coordinator while the session lives.
        enqueued.delivery.catch((error) => {
          appLog.warn(
            { err: error, agentId },
            "Deferred tmux prompt delivery failed — agent may have exited"
          );
        });
        return;
      }
      await enqueued.delivery;
    } catch (error) {
      if (opts.swallowFailure === false) {
        throw error;
      }
      appLog.warn(
        { err: error, agentId },
        "Failed to inject tmux prompt — agent may have exited"
      );
    }
  };

  return { enqueueAgentPrompt, injectAgentPrompt };
}
