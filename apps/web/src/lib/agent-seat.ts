import { descendantAgents } from "@/lib/agent-lineage";

const MAX_DEPTH = 64;

/** The top of an agent's tree: the first ancestor with no known parent. */
function rootOf(agentId: string, byId: Map<string, SeatedAgent>): string {
  let current = agentId;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const parent = byId.get(current)?.parentAgentId;
    if (!parent || !byId.has(parent)) return current;
    current = parent;
  }
  return current;
}

/**
 * An agent's seat in its tree: the root is 1 and every agent under it
 * takes the next number in the order it was created, so a stream reads
 * "1 asked, 2 answered, 3 reviewed" and each number keeps its own colour
 * for the life of the tree.
 */
export type SeatedAgent = {
  id: string;
  parentAgentId?: string | null;
  createdAt?: string;
};

export function lineageSeats(
  agentId: string,
  agents: readonly SeatedAgent[]
): Readonly<Record<string, number>> {
  if (!agentId) return {};
  const rootId = rootOf(agentId, new Map(agents.map((a) => [a.id, a])));
  const members = descendantAgents(rootId, agents as SeatedAgent[]).sort(
    (a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "")
  );
  const seats: Record<string, number> = { [rootId]: 1 };
  members.forEach((agent, index) => {
    seats[agent.id] = index + 2;
  });
  return seats;
}

/** Ten accents; an eleventh agent wears the first again. */
const SEAT_PALETTE = [
  "border-sky-500/40 bg-sky-500/15 text-sky-700 dark:text-sky-300",
  "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300",
  "border-violet-500/40 bg-violet-500/15 text-violet-700 dark:text-violet-300",
  "border-rose-500/40 bg-rose-500/15 text-rose-700 dark:text-rose-300",
  "border-teal-500/40 bg-teal-500/15 text-teal-700 dark:text-teal-300",
  "border-orange-500/40 bg-orange-500/15 text-orange-700 dark:text-orange-300",
  "border-fuchsia-500/40 bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300",
  "border-lime-500/40 bg-lime-500/15 text-lime-700 dark:text-lime-300",
  "border-cyan-500/40 bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
] as const;

export function seatClasses(seat: number): string {
  return SEAT_PALETTE[(Math.max(1, seat) - 1) % SEAT_PALETTE.length]!;
}
