import type { FastifyBaseLogger } from "fastify";

import type { AgentManager } from "../agents/manager.js";
import type { InjectionCoordinator } from "../terminal/injection-coordinator.js";
import { TmuxTerminal } from "../terminal/tmux-terminal.js";

export function createPromptInjector(
  agentManager: AgentManager,
  appLog: FastifyBaseLogger,
  coordinator: InjectionCoordinator,
  forwardToPeer?: (
    peerId: string,
    remoteAgentId: string,
    prompt: string
  ) => Promise<void>
) {
  return async function injectAgentPrompt(
    agentId: string,
    prompt: string,
    opts: { swallowFailure?: boolean; awaitDelivery?: boolean } = {}
  ): Promise<void> {
    try {
      // Shadow rows have no pane here — the peer service intercepts and the
      // prompt is injected by the instance that actually runs the agent.
      const record = await agentManager.getAgent(agentId);
      if (record?.peerId && record.remoteId && forwardToPeer) {
        await forwardToPeer(record.peerId, record.remoteId, prompt);
        return;
      }
      const access = await agentManager.getTerminalAccess(agentId);
      if (access.mode !== "tmux") {
        const err = new Error(
          "Agent has no active terminal session — prompt cannot be delivered."
        );
        if (opts.swallowFailure === false) {
          throw err;
        }
        appLog.debug(
          { agentId, mode: access.mode },
          "Skipping tmux injection — agent has no tmux session"
        );
        return;
      }
      const terminal = new TmuxTerminal(access.sessionName);
      const delivery = coordinator.inject(agentId, () =>
        terminal.sendCommand(prompt)
      );
      if (opts.awaitDelivery === false) {
        // Caller only needs enqueue confirmation (e.g. MCP tool calls that
        // would time out waiting for the quiet gate); FIFO delivery is
        // guaranteed by the coordinator while the session lives.
        delivery.catch((error) => {
          appLog.warn(
            { err: error, agentId },
            "Deferred tmux prompt delivery failed — agent may have exited"
          );
        });
        return;
      }
      await delivery;
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
}
