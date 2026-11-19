import type { PromptImage, PromptSource } from "@dispatch/runner-protocol";
export type { PromptImage, PromptSource } from "@dispatch/runner-protocol";

const SYSTEM_MAX = 500;

/** An internal prompt's turn source; never infer a chat post from its text. */
export function systemPromptSource(text: string): PromptSource {
  return { source: "system", text: text.slice(0, SYSTEM_MAX) };
}

/** A prompt waiting its turn in the supervisor's queue, as routes read it. */
export type QueuedPrompt = {
  /** The chat message id for a chat prompt; otherwise a queue-local id. */
  id: string;
  source: PromptSource;
  createdAt: string;
};

export type PromptOptions = {
  alone?: boolean;
  /** Checked immediately before submission, including queued release. */
  beforeSubmit?: () => Promise<boolean>;
  /** A steering attempt was definitively declined and is now queued. */
  onDeferred?: () => Promise<void>;
  signal?: AbortSignal;
  images?: PromptImage[];
  delivery?: "auto" | "queue" | "interrupt";
};
