/**
 * `@name` in a message names an agent in the stream's tree. The server is
 * the authority on who a post reaches; this is the client's half: the
 * picker's candidates, the token under the caret, and the spans to paint.
 */
export type Mentionable = {
  id: string;
  name: string;
  /** Its number in the tree, drawn beside the name. */
  seat?: number;
};

/** The `@query` the caret sits in, or null when it sits in plain text. */
export function mentionQueryAt(
  text: string,
  caret: number
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  // An @ inside a word (an email) is not a mention.
  if (at > 0 && /[\p{L}\p{N}_]/u.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  // A query runs to the caret without a line break; spaces are fine, names
  // hold them.
  if (/[\n\r]/.test(query)) return null;
  return { start: at, query };
}

/** Candidates for a query: by name, then by seat number, in tree order. */
export function matchMentionables(
  query: string,
  agents: readonly Mentionable[]
): Mentionable[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...agents];
  return agents.filter(
    (agent) =>
      agent.name.toLowerCase().includes(q) ||
      (agent.seat !== undefined && String(agent.seat) === q)
  );
}

/** The text with `@query` at `start` replaced by `@Name `, and where the caret lands. */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  agent: Mentionable
): { text: string; caret: number } {
  const token = `@${agent.name} `;
  // Reuse a following space rather than adding a second one after the token.
  const suffix = text.slice(caret);
  const next =
    text.slice(0, start) +
    token +
    (suffix.startsWith(" ") ? suffix.slice(1) : suffix);
  return { text: next, caret: start + token.length };
}

export type MentionSpan =
  | { kind: "text"; text: string }
  | { kind: "mention"; text: string; agent: Mentionable };

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Splits a message into plain runs and the mentions it holds, for painting. */
export function mentionSpans(
  text: string,
  agents: readonly Mentionable[]
): MentionSpan[] {
  if (!text.includes("@") || agents.length === 0) {
    return text ? [{ kind: "text", text }] : [];
  }
  const byLength = [...agents]
    .filter((a) => a.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  const hits: Array<{ start: number; end: number; agent: Mentionable }> = [];
  for (const agent of byLength) {
    const re = new RegExp(
      `(^|[\\s([{"'])@${escapeRegExp(agent.name.trim())}(?=$|[^\\p{L}\\p{N}_])`,
      "giu"
    );
    for (const match of text.matchAll(re)) {
      const start = match.index + match[1]!.length;
      const end = start + 1 + agent.name.trim().length;
      if (hits.some((h) => start < h.end && end > h.start)) continue;
      hits.push({ start, end, agent });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  const spans: MentionSpan[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start > cursor) {
      spans.push({ kind: "text", text: text.slice(cursor, hit.start) });
    }
    spans.push({
      kind: "mention",
      text: text.slice(hit.start, hit.end),
      agent: hit.agent,
    });
    cursor = hit.end;
  }
  if (cursor < text.length)
    spans.push({ kind: "text", text: text.slice(cursor) });
  return spans;
}
