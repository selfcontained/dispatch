import { seatClasses } from "@/lib/agent-seat";
import { cn } from "@/lib/utils";

/**
 * `@name` names an agent in this tree or another running parent session. The server is
 * the authority on who a post reaches; this is the client's half: the
 * picker's candidates, the token under the caret, and the spans to paint.
 */
export type Mentionable = {
  id: string;
  name: string;
  mentionName?: string;
  qualifiedMentionName?: string;
  agentType?: string | null;
  /** Historical routing metadata limits which token modes may name this identity. */
  mentionModes?: readonly ("mention" | "reference")[];
  /** Its number in the tree, drawn beside the name. */
  seat?: number;
};

/** The `@query` the caret sits in, or null when it sits in plain text. */
export function mentionQueryAt(
  text: string,
  caret: number
): { start: number; query: string; silent?: boolean } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  // An @ inside a word (an email) is not a mention.
  if (at > 0 && /[\p{L}\p{N}_]/u.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  // A query runs to the caret without a line break; spaces are fine, names
  // hold them.
  if (/[\n\r]/.test(query)) return null;
  const silent = at > 0 && before[at - 1] === "!";
  const start = silent ? at - 1 : at;
  if (start > 0 && /[\p{L}\p{N}_]/u.test(before[start - 1]!)) return null;
  return { start, query, ...(silent ? { silent: true } : {}) };
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
  const silent = text[start] === "!";
  const token = `${silent ? "!" : ""}@${agent.mentionName ?? agent.name} `;
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
  | { kind: "mention"; text: string; agent: Mentionable; silent?: boolean };

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Splits a message into plain runs and the mentions it holds, for painting. */
export function mentionSpans(
  text: string,
  agents: readonly Mentionable[]
): MentionSpan[] {
  if (!text.includes("@") || agents.length === 0) {
    return text ? [{ kind: "text", text }] : [];
  }
  const byLength = agents
    .flatMap((agent) => {
      const name = (agent.mentionName ?? agent.name).trim();
      const qualified = agent.qualifiedMentionName;
      return [
        { agent, name },
        ...(qualified && qualified !== name
          ? [{ agent, name: qualified }]
          : []),
      ];
    })
    .filter(({ name }) => name.length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  const hits: Array<{
    start: number;
    end: number;
    agent: Mentionable;
    silent?: boolean;
  }> = [];
  for (const { agent, name } of byLength) {
    const re = new RegExp(
      `(^|[\\s([{"'])(!?)@${escapeRegExp(name)}(?=$|[^\\p{L}\\p{N}_])`,
      "giu"
    );
    for (const match of text.matchAll(re)) {
      const mode = match[2] ? "reference" : "mention";
      if (agent.mentionModes && !agent.mentionModes.includes(mode)) continue;
      const start = match.index + match[1]!.length;
      const end = start + match[2]!.length + 1 + name.length;
      if (hits.some((h) => start < h.end && end > h.start)) continue;
      hits.push({ start, end, agent, ...(match[2] ? { silent: true } : {}) });
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
      ...(hit.silent ? { silent: true } : {}),
    });
    cursor = hit.end;
  }
  if (cursor < text.length)
    spans.push({ kind: "text", text: text.slice(cursor) });
  return spans;
}

// Keep picker, editable decorations, and sent chips on the same geometry.
export function mentionChipClasses(
  seat: number | undefined,
  silent = false
): string {
  return cn(
    "agent-mention-chip box-decoration-clone rounded-full border px-1 py-0 text-xs font-medium",
    seatClasses(seat ?? 1).face,
    silent && "saturate-[0.8] opacity-90"
  );
}
