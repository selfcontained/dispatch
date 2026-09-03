export type PublishUiEvent = (event: unknown) => void;
export type SendAgentPrompt = (
  agentId: string,
  prompt: string,
  opts?: { swallowFailure?: boolean; awaitDelivery?: boolean }
) => Promise<void>;
export type { EnqueueAgentPrompt } from "./agent-prompts.js";
