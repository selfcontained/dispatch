/**
 * The pane-injection envelope wrapping a user's Chat message. The trailing
 * line tells the agent how to answer so the reply lands back in the Chat
 * tab (docs/chat-surface-plan.md, "Injection envelope").
 *
 * `attachmentLines` (one `- kind: …` line each) are listed after the text and
 * before the closing marker so the agent can act on them. A blank text with
 * attachments lists only the attachments.
 */
export function buildChatEnvelope(
  messageId: string,
  text: string,
  attachmentLines: string[] = []
): string {
  const body: string[] = [];
  if (text.trim().length > 0) body.push(text);
  if (attachmentLines.length > 0) {
    if (body.length > 0) body.push("");
    body.push("Attachments:", ...attachmentLines);
  }
  return [
    `--- DISPATCH CHAT (id: ${messageId}) ---`,
    ...body,
    "--- END DISPATCH CHAT ---",
    `The user is reading the Chat tab, not this terminal — they only see what you post with dispatch_chat_post. Reply there (replyTo: "${messageId}"); terminal output alone will not reach them.`,
  ].join("\n");
}

/** `120 KB`, `3.4 MB`, `900 B` — for the attachment lines. */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
