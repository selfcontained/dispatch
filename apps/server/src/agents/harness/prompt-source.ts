/**
 * What a prompt sent to the harness was, for the prompt a turn entry
 * renders. The wire text is an envelope Dispatch built; the feed wants the
 * human-facing source behind it, not the envelope.
 */
export type PromptSource =
  | { source: "chat"; chatMessageId: string }
  | { source: "agent"; senderId: string; senderName: string; text: string }
  | { source: "system"; text: string };

// The id has to be the strict UUID shape, not 36 characters of the same
// alphabet: it is read back through a `::uuid[]` cast, and a value Postgres
// rejects there turns every later read of that agent's turns into a 500. The
// header is matched on every prompt that reaches the queue, and review
// injection prompts embed feedback bodies verbatim, so the text is not
// always Dispatch's own.
const CHAT_HEADER =
  /^--- DISPATCH CHAT \(id: ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\) ---/m;
const MESSAGE_BLOCK =
  /^--- DISPATCH MESSAGE ---\n([\s\S]*?)\n--- END MESSAGE ---/m;
const SYSTEM_MAX = 500;

export function parsePromptSource(text: string): PromptSource {
  const chat = CHAT_HEADER.exec(text);
  if (chat) return { source: "chat", chatMessageId: chat[1] };
  const message = MESSAGE_BLOCK.exec(text);
  if (message) {
    try {
      const body = JSON.parse(message[1]) as {
        from?: unknown;
        senderId?: unknown;
        message?: unknown;
      };
      if (typeof body.message === "string") {
        return {
          source: "agent",
          senderId: typeof body.senderId === "string" ? body.senderId : "",
          senderName: typeof body.from === "string" ? body.from : "agent",
          text: body.message,
        };
      }
    } catch {
      // Not JSON after all; treat the whole thing as a system prompt.
    }
  }
  return { source: "system", text: text.slice(0, SYSTEM_MAX) };
}

/** A prompt waiting its turn in the supervisor's queue, as routes read it. */
export type QueuedPrompt = {
  /** The chat message id for a chat prompt; otherwise a queue-local id. */
  id: string;
  source: PromptSource;
  createdAt: string;
};
