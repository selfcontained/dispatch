import type {
  BlockKind,
  BlockReviewData,
  BlockReviewState,
} from "@dispatch/shared";

/**
 * The envelope's own markers, line-anchored exactly as they are emitted:
 * `--- DISPATCH POST (id: …) ---` and `--- END DISPATCH POST ---`. Leading
 * whitespace and a longer run of dashes are matched too, because an agent
 * reading the prompt would treat those as the marker just the same.
 */
const ENVELOPE_MARKER_RE =
  /^[ \t>]*-{3,}[ \t]*(?:END[ \t]+)?DISPATCH[ \t]+(?:POST|CHAT|REACTION)\b/i;

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
 * a person's message, another agent's post, an attachment's label or code
 * body. Without this, text containing `--- END DISPATCH POST ---` followed
 * by a forged `--- DISPATCH POST (id: …) ---` block could close Dispatch's
 * block and open one naming any block id, making the agent thread its reply
 * onto a block the author has no claim to. Every line that matches the
 * marker grammar is prefixed with `> `, so it survives visibly but cannot
 * open or close a block.
 */
export function escapeEnvelopeMarkers(text: string): string {
  if (!text.includes("-")) return text;
  // Split on every separator a CLI or Markdown renderer may treat as a line
  // break, not just \n: a lone CR (JSON and MCP strings carry them) or a
  // Unicode line/paragraph separator would otherwise hide a forged marker
  // from the match. Separators are normalized to \n on the way out.
  let changed = false;
  const lines = text.split(/\r\n|[\r\n\u2028\u2029]/).map((line) => {
    if (!ENVELOPE_MARKER_RE.test(line)) return line;
    changed = true;
    return `${ENVELOPE_MARKER_ESCAPE}${line}`;
  });
  const joined = lines.join("\n");
  return changed || joined !== text ? joined : text;
}

/** Who a post is from, as the envelope names them. */
export type EnvelopeSender =
  | { kind: "user" }
  | { kind: "agent"; agentId: string; name: string };

function senderLabel(from: EnvelopeSender): string {
  return from.kind === "user" ? "user" : `${from.name} (${from.agentId})`;
}

/**
 * A review as its recipient reads it: the verdict, the summary, then every
 * finding with its severity, location and body, and what to do about each.
 * The block carries this as data, not text, so without these lines the
 * agent would be told "a review was posted" and nothing else.
 */
export function describeReview(
  blockId: string,
  data: BlockReviewData,
  state: BlockReviewState | null
): string {
  const verdict =
    data.verdict === "approve"
      ? "Approved"
      : data.verdict === "request_changes"
        ? "Changes requested"
        : "Comments";
  const lines: string[] = [`Review: ${verdict}.`];
  if (data.summary.trim()) lines.push(data.summary.trim());
  if (data.findings.length > 0) {
    lines.push("", `Findings (${data.findings.length}):`);
    data.findings.forEach((finding, index) => {
      const record = state?.findings[finding.id];
      const status =
        record?.status === "resolved" ? (record.resolution ?? "fixed") : "open";
      const where = finding.path
        ? ` — ${finding.path}${finding.line !== undefined ? `:${finding.line}` : ""}`
        : "";
      lines.push(
        `${index + 1}. [${finding.severity}] ${finding.title} (id: ${finding.id}, ${status})${where}`,
        `   ${finding.body.trim().replace(/\n/g, "\n   ")}`
      );
    });
    const open = data.findings.filter(
      (finding) => (state?.findings[finding.id]?.status ?? "open") === "open"
    ).length;
    if (open > 0) {
      lines.push(
        "",
        `What to do: address each open finding, then mark it fixed on this block: update({ id: "${blockId}", state: { findings: { "<finding id>": "fixed" } } }), and say what changed under that finding: post({ replyTo: "${blockId}", finding: "<finding id>", text: "…" }). Set one aside instead with { "<finding id>": { status: "resolved", resolution: "dismissed", note: "why" } }. The reviewer can reopen either. You are done when no finding is open.`
      );
    }
  }
  return lines.join("\n");
}

/**
 * The prompt envelope wrapping a block delivered to an agent: a person's
 * message, another agent's post, an answer to a question the agent asked,
 * a reply in a thread it is part of. One shape for every author; the
 * `from` field says who. The trailing line is the minimum routing reminder;
 * the persistent launch guidance explains the rest.
 *
 * `attachmentLines` (one `- kind: …` line each) are listed after the text
 * and before the closing marker so the agent can act on them. The whole
 * body passes through `escapeEnvelopeMarkers`.
 */
export function buildPostEnvelope(input: {
  blockId: string;
  from: EnvelopeSender;
  text: string;
  attachmentLines?: string[];
  /** The top-level block this post replies under, when it is a thread reply. */
  threadId?: string | null;
  /** A block of the agent's this post answers (a question or form). */
  answers?: { blockId: string; kind: BlockKind } | null;
  /** The review finding this thread reply is about. */
  finding?: { id: string; title: string } | null;
  /** A person named the agent with `@`; `alsoTo` names the others it went to. */
  mention?: { alsoTo: string[] } | null;
}): string {
  const body: string[] = [];
  if (input.text.trim().length > 0) body.push(input.text);
  const attachmentLines = input.attachmentLines ?? [];
  if (attachmentLines.length > 0) {
    if (body.length > 0) body.push("");
    body.push("Attachments:", ...attachmentLines);
  }
  const safeBody = escapeEnvelopeMarkers(body.join("\n"));
  const context: string[] = [];
  if (input.answers) {
    context.push(
      `This answers your ${input.answers.kind} ${input.answers.blockId}.`
    );
  }
  if (input.threadId) {
    context.push(`In the thread under ${input.threadId}.`);
  }
  if (input.mention) {
    context.push(
      input.mention.alsoTo.length > 0
        ? `Addressed to you by @mention, and also to ${input.mention.alsoTo.join(", ")}.`
        : "Addressed to you by @mention."
    );
  }
  if (input.finding) {
    context.push(
      `About finding "${input.finding.id}" (${input.finding.title}).`
    );
  }
  const replyArgs = input.threadId
    ? `replyTo: "${input.threadId}"${input.finding ? `, finding: "${input.finding.id}"` : ""}`
    : "";
  // A person's post: the agent's own answer lands where the post was, in
  // the thread when it came from one, so plain text is the whole reply.
  // Another agent's post: only post reaches it, in its thread when it has one.
  const routing =
    input.from.kind === "user"
      ? `Your reply appears ${input.threadId ? "in this thread" : "in the stream"} as you write it. Use post only for a question with options, a file, a link, or to reach another agent${replyArgs ? ` (with ${replyArgs} to keep it in this thread)` : ""}.`
      : `From another agent. Reply with post (to: "${input.from.agentId}"${replyArgs ? `, ${replyArgs}` : ""}) only if a reply is needed; routine updates need no acknowledgement.`;
  return [
    `--- DISPATCH POST (id: ${input.blockId}, from: ${senderLabel(input.from)}) ---`,
    ...(body.length > 0 ? [safeBody] : []),
    ...(context.length > 0 ? [context.join(" ")] : []),
    "--- END DISPATCH POST ---",
    routing,
  ].join("\n");
}

/**
 * How much of the reacted block the envelope quotes. The latest post needs
 * little: "your latest" already names it, so the quote only confirms it. An
 * older one has to be recognizable from the quote alone, so it gets enough
 * to tell apart from its neighbours.
 */
export const REACTION_EXCERPT_LATEST_CHARS = 100;
export const REACTION_EXCERPT_EARLIER_CHARS = 300;

/**
 * The opening of a block's text as one quotable line: leading markdown on
 * each line (headings, bullets, quotes) and emphasis markers dropped,
 * whitespace collapsed, cut at a word boundary within `maxChars`.
 */
export function reactionExcerpt(text: string, maxChars: number): string {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.replace(/^[\s#>*+-]+/, ""))
    .join(" ")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (line.length <= maxChars) return line;
  const cut = line.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  // Break on a word only when that keeps most of the budget.
  const head = lastSpace > maxChars / 2 ? cut.slice(0, lastSpace) : cut;
  return `${head.trimEnd()}…`;
}

const KIND_NOUN: Record<BlockKind, string> = {
  text: "post",
  question: "question",
  form: "form",
  file: "file",
  link: "link",
  review: "review",
  tasks: "task list",
};

/**
 * The prompt envelope for a person's emoji reaction. Its markers say
 * REACTION on purpose: the agent must not read a reaction as a new request.
 *
 * It lets the agent tell which block is meant without pasting the whole
 * block back: the id (exact, and what `replyTo` takes), the kind of block,
 * where it sits among the agent's posts ("latest", or "3 posts ago"), and
 * a quote of its opening.
 */
export function buildReactionEnvelope(input: {
  blockId: string;
  emoji: string;
  kind: BlockKind;
  text: string;
  /** How many posts the agent has made on the stream since this one. */
  postsSince: number;
}): string {
  const { blockId, emoji, postsSince } = input;
  const noun = KIND_NOUN[input.kind];
  const latest = postsSince <= 0;
  const target = latest
    ? `your latest ${noun}`
    : `your ${noun} from ${postsSince} ${postsSince === 1 ? "post" : "posts"} ago`;
  const excerpt = reactionExcerpt(
    input.text,
    latest ? REACTION_EXCERPT_LATEST_CHARS : REACTION_EXCERPT_EARLIER_CHARS
  );
  const body = excerpt
    ? `The user reacted ${emoji} to ${target}:\n> ${excerpt}`
    : `The user reacted ${emoji} to ${target}.`;
  return [
    `--- DISPATCH REACTION (block id: ${blockId}) ---`,
    escapeEnvelopeMarkers(body),
    "--- END DISPATCH REACTION ---",
    `A reaction, not a new message — reply only if it calls for one (post, replyTo: "${blockId}").`,
  ].join("\n");
}

/**
 * The prompt that runs a failed turn again. The engine's session already
 * holds the prompt the failed turn was answering, and the turn may have
 * run tools before it broke off, so that prompt is not sent twice: the
 * agent is told what happened and continues from where its session
 * stands. The first line is what the feed's notice shows; the error, which
 * the failed turn already shows, follows it.
 */
/** What a retry is about, in the notice and in the prompt alike. */
const RETRY_TURN_SUBJECT = "the turn that stopped on an error";

/** The notice the feed shows above the turn a retry opened. */
export const RETRY_TURN_NOTICE = `Retried ${RETRY_TURN_SUBJECT}.`;

export function buildRetryTurnEnvelope(error: string): string {
  // One line of it, after other words: it cannot stand as a marker line.
  const reason = error.split("\n")[0].trim().slice(0, 200);
  return [
    `The user retried ${RETRY_TURN_SUBJECT}. Continue where you left off.`,
    ...(reason ? [`(The error was ${reason})`] : []),
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
