export type { PublishUiEvent } from "./ui-events.js";
export type SendAgentPrompt = (
  agentId: string,
  prompt: string,
  opts?: { swallowFailure?: boolean; awaitDelivery?: boolean }
) => Promise<void>;
export type { EnqueueAgentPrompt } from "./agent-prompts.js";
