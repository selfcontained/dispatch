/**
 * The envelope's own markers, line-anchored exactly as they are emitted:
 * `--- DISPATCH CHAT (id: …) ---` and `--- END DISPATCH CHAT ---`. Leading
 * whitespace and a longer run of dashes are matched too, because an agent
 * reading the pane would treat those as the marker just the same.
 */
const ENVELOPE_MARKER_RE =
  /^[ \t>]*-{3,}[ \t]*(?:END[ \t]+)?DISPATCH[ \t]+CHAT\b/i;

/**
 * What a neutralized marker line is prefixed with. `> ` is deliberate: it
 * reads as a quotation to a human and to the agent, it needs no exotic
 * code points (nothing zero-width, nothing that a copy/paste would lose),
 * and it moves the `---` off the start of the line so the line can no
 * longer be read as a marker.
 */
export const ENVELOPE_MARKER_ESCAPE = "> ";

/**
 * Neutralize any envelope marker inside caller-supplied text.
 *
 * The envelope is a plain-text frame around text Dispatch does not control:
 * a user's Chat message, a launching agent's prompt, an attachment's pin
 * label or code body. Without this, text containing
 * `--- END DISPATCH CHAT ---` followed by a forged
 * `--- DISPATCH CHAT (id: …) ---` block could close Dispatch's block and open
 * one naming any message id, making the agent thread its reply onto a
 * message the author has no claim to. Every line that matches the marker
 * grammar is prefixed with `> `, so it survives visibly but cannot open or
 * close a block.
 *
 * Applied inside `buildChatEnvelope`, which is the single place any text is
 * wrapped — the composer path and the launch path therefore agree.
 */
export function escapeEnvelopeMarkers(text: string): string {
  if (!text.includes("-")) return text;
  let changed = false;
  const lines = text.split("\n").map((line) => {
    if (!ENVELOPE_MARKER_RE.test(line)) return line;
    changed = true;
    return `${ENVELOPE_MARKER_ESCAPE}${line}`;
  });
  return changed ? lines.join("\n") : text;
}

/**
 * The pane-injection envelope wrapping a user's Chat message. The trailing
 * line tells the agent how to answer so the reply lands back in the Chat
 * tab (docs/chat-surface-plan.md, "Injection envelope").
 *
 * `attachmentLines` (one `- kind: …` line each) are listed after the text and
 * before the closing marker so the agent can act on them. A blank text with
 * attachments lists only the attachments.
 *
 * The whole body — text and attachment lines alike — passes through
 * `escapeEnvelopeMarkers`, so nothing embedded here can forge a block.
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
  const safeBody = escapeEnvelopeMarkers(body.join("\n"));
  return [
    `--- DISPATCH CHAT (id: ${messageId}) ---`,
    ...(body.length > 0 ? [safeBody] : []),
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
