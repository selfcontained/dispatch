/**
 * What a prompt sent to the harness was, for the Harness view's prompt
 * line. The wire text is an envelope Dispatch built; the view wants the
 * human-facing source behind it, not the envelope.
 */
export type PromptSource =
  | { source: "chat"; chatMessageId: string }
  | { source: "agent"; senderId: string; senderName: string; text: string }
  | { source: "system"; text: string };

const CHAT_HEADER = /^--- DISPATCH CHAT \(id: ([0-9a-f-]{36})\) ---/m;
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
