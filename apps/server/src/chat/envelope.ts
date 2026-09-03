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
    `The user is reading the Chat tab, not this terminal — they only see what you post with dispatch_chat_post. Reply there (replyTo: "${messageId}"); terminal output alone will not reach them.`,
  ].join("\n");
}
