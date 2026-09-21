/**
 * `@name` in a person's post picks who it is for. Names are matched against
 * the agents in the stream's tree, longest first (a name may hold spaces),
 * case-insensitively, at a word edge on both sides. The result lists agent
 * ids in order of first mention, each once.
 */
export type Mentionable = { id: string; name: string };

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function findMentions(
  text: string,
  agents: readonly Mentionable[]
): string[] {
  if (!text.includes("@") || agents.length === 0) return [];
  const byLength = [...agents]
    .filter((a) => a.name.trim().length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  const hits: Array<{ at: number; id: string }> = [];
  // Consumed spans, so "@badge demo parent" is not also "@badge demo".
  const taken: Array<[number, number]> = [];
  for (const agent of byLength) {
    const re = new RegExp(
      `(^|[\\s([{"'])@${escapeRegExp(agent.name.trim())}(?=$|[^\\p{L}\\p{N}_])`,
      "giu"
    );
    for (const match of text.matchAll(re)) {
      const start = match.index + match[1].length;
      const end = start + 1 + agent.name.trim().length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      taken.push([start, end]);
      hits.push({ at: start, id: agent.id });
    }
  }
  hits.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hit of hits) {
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    out.push(hit.id);
  }
  return out;
}
