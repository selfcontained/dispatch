import type { FastifyBaseLogger } from "fastify";

import { shouldSuggestSessionRename } from "./tmux/session-name.js";
import type { AgentLatestEventInput, AgentRecord } from "./types.js";

/**
 * The canned prompt sent to an agent when we ask it to set a descriptive
 * session name. Used by the manual sidebar button and the auto-inject
 * listener so both paths produce the same agent-facing message.
 */
export const RENAME_PROMPT =
  "Please set a short, descriptive name for this session that reflects the work you're doing — call the `dispatch_rename_session` MCP tool with the new name. Then continue with whatever you were doing.";

function isTerminalEventType(value: AgentLatestEventInput["type"]): boolean {
  return (
    value === "blocked" ||
    value === "waiting_user" ||
    value === "done" ||
    value === "idle"
  );
}

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
 * the first time an agent transitions terminal → working, gated on the
 * session name still matching its default placeholder. One-shot per agent
 * (per process lifetime). Terminal-type and persona agents are skipped —
 * they have no Claude session to receive the prompt or already carry a
 * meaningful name.
 */
export function createAutoRenamePrompter(deps: AutoRenamePrompterDeps) {
  const state = new Map<
    string,
    { lastEventType: AgentLatestEventInput["type"]; prompted: boolean }
  >();

  return function onLatestEvent(agent: AgentRecord): void {
    const newType = agent.latestEvent?.type;
    if (!newType) return;

    const entry = state.get(agent.id);
    const prevType = entry?.lastEventType;
    const alreadyPrompted = entry?.prompted ?? false;

    state.set(agent.id, { lastEventType: newType, prompted: alreadyPrompted });

    if (alreadyPrompted) return;
    if (newType !== "working") return;
    if (!prevType || !isTerminalEventType(prevType)) return;
    if (agent.type === "terminal") return;
    if (
      !shouldSuggestSessionRename(agent.name, agent.id, {
        persona: agent.persona,
      })
    ) {
      return;
    }

    state.set(agent.id, { lastEventType: newType, prompted: true });

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
