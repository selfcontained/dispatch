import type { FastifyBaseLogger } from "fastify";

import { shouldSuggestSessionRename } from "./tmux/session-name.js";
import type { AgentRecord } from "./types.js";

/**
 * The canned prompt sent to an agent when we ask it to set a descriptive
 * session name. Used by the manual sidebar button and the auto-inject
 * listener so both paths produce the same agent-facing message.
 */
export const RENAME_PROMPT =
  "Please set a short, descriptive name for this session that reflects the work you're doing — call the `dispatch_rename_session` MCP tool with the new name. Then continue with whatever you were doing.";

type InjectAgentPrompt = (
  agentId: string,
  prompt: string,
  opts?: { swallowFailure?: boolean }
) => Promise<void>;

type AutoRenamePrompterDeps = {
  injectAgentPrompt: InjectAgentPrompt;
  log: FastifyBaseLogger;
};

/**
 * Returns an `onLatestEvent` listener that auto-injects the rename prompt
 * the first time an agent emits a "working" event while its session name
 * is still the default placeholder. One-shot per agent (per process
 * lifetime). Terminal-type and persona agents are skipped — they have no
 * Claude session to receive the prompt or already carry a meaningful name.
 *
 * Agents start with an `idle` system event, so the first agent-initiated
 * "working" event naturally triggers the prompt.
 */
export function createAutoRenamePrompter(deps: AutoRenamePrompterDeps) {
  const prompted = new Set<string>();

  return function onLatestEvent(agent: AgentRecord): void {
    if (agent.latestEvent?.type !== "working") return;
    if (prompted.has(agent.id)) return;
    if (agent.type === "terminal") return;
    if (
      !shouldSuggestSessionRename(agent.name, agent.id, {
        persona: agent.persona,
      })
    ) {
      return;
    }

    prompted.add(agent.id);

    void deps
      .injectAgentPrompt(agent.id, RENAME_PROMPT)
      .catch((err: unknown) => {
        deps.log.warn(
          { err, agentId: agent.id },
          "Auto rename-prompt injection failed"
        );
      });
  };
}
