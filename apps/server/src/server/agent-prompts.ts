import type { FastifyBaseLogger } from "fastify";

import type { AgentManager } from "../agents/manager.js";
import { TmuxTerminal } from "../terminal/tmux-terminal.js";

export function createPromptInjector(
  agentManager: AgentManager,
  appLog: FastifyBaseLogger
) {
  return async function injectAgentPrompt(
    agentId: string,
    prompt: string,
    opts: { swallowFailure?: boolean } = {}
  ): Promise<void> {
    try {
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
      // OpenCode renders large pastes as a "[Pasted text …]" placeholder.
      // That is a UI representation, not a pending tmux paste; retrying Enter
      // against it can trigger OpenCode's keymap resolver error. Keep the
      // legacy retry for Codex/Claude, where it was added to recover queued
      // large-paste submissions.
      await terminal.sendCommand(prompt, {
        retryLargePaste: access.agentType !== "opencode",
      });
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
