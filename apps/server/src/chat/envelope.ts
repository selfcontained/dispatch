/**
 * The pane-injection envelope wrapping a user's Chat message. The trailing
 * line tells the agent how to answer so the reply lands back in the Chat
 * tab (docs/chat-surface-plan.md, "Injection envelope").
 */
export function buildChatEnvelope(messageId: string, text: string): string {
  return [
    `--- DISPATCH CHAT (id: ${messageId}) ---`,
    text,
    "--- END DISPATCH CHAT ---",
    `Reply in the Chat tab with dispatch_chat_post (replyTo: "${messageId}").`,
  ].join("\n");
}
