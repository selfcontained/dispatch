import type { FastifyBaseLogger } from "fastify";

import type { AgentManager } from "../agents/manager.js";
import type { PromptSource } from "../agents/acp/prompt-source.js";

/**
 * Enqueue a prompt for an agent and return at once. Resolves once the prompt
 * is queued behind the agent's running turn (serialized per agent). Throws
 * when the agent has no live session. `delivery` settles when the engine
 * has accepted the prompt (or the queue failed); `held` reports whether a
 * turn is running ahead of it right now.
 */
export type EnqueueAgentPrompt = (
  agentId: string,
  prompt: string,
  opts?: { gate?: boolean; source?: PromptSource }
) => Promise<{ held: boolean; delivery: Promise<void> }>;

export type InjectAgentPrompt = (
  agentId: string,
  prompt: string,
  opts?: { swallowFailure?: boolean; awaitDelivery?: boolean }
) => Promise<void>;

export function createPromptInjector(
  agentManager: AgentManager,
  appLog: FastifyBaseLogger
): {
  enqueueAgentPrompt: EnqueueAgentPrompt;
  injectAgentPrompt: InjectAgentPrompt;
} {
  const enqueueAgentPrompt: EnqueueAgentPrompt = async (
    agentId,
    prompt,
    opts
  ) => {
    const access = await agentManager.getTerminalAccess(agentId);
    if (access.mode !== "live") {
      throw new Error(
        "Agent has no live session — prompt cannot be delivered."
      );
    }
    const { accepted, settled } = agentManager.promptAgent(
      agentId,
      prompt,
      opts?.source
    );
    settled.catch((err: unknown) => {
      appLog.warn({ err, agentId }, "agent turn failed");
    });
    return { held: agentManager.isPromptHeld(agentId), delivery: accepted };
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
          "Skipping prompt — agent has no live session"
        );
        return;
      }
      if (opts.awaitDelivery === false) {
        enqueued.delivery.catch((error) => {
          appLog.warn(
            { err: error, agentId },
            "Deferred prompt delivery failed — agent may have exited"
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
        "Failed to deliver prompt — agent may have exited"
      );
    }
  };

  return { enqueueAgentPrompt, injectAgentPrompt };
}
