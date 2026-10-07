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
const SEAT_PALETTE: readonly SeatClasses[] = [
  seatAccent("sky"),
  seatAccent("emerald"),
  seatAccent("amber"),
  seatAccent("violet"),
  seatAccent("rose"),
  seatAccent("teal"),
  seatAccent("orange"),
  seatAccent("fuchsia"),
  seatAccent("lime"),
  seatAccent("cyan"),
];

/** The face is washed in the accent; the number chip is solid. */
export type SeatClasses = { face: string; chip: string };

// Theme mode is a data attribute, not Tailwind's .dark class.
// Spelled out per colour so Tailwind sees every class it must emit.
function seatAccent(colour: string): SeatClasses {
  const faces: Record<string, string> = {
    sky: "border-sky-500/40 bg-sky-500/15 text-sky-800 [[data-theme-mode=dark]_&]:text-sky-300",
    emerald:
      "border-emerald-500/40 bg-emerald-500/15 text-emerald-800 [[data-theme-mode=dark]_&]:text-emerald-300",
    amber:
      "border-amber-500/40 bg-amber-500/15 text-amber-800 [[data-theme-mode=dark]_&]:text-amber-300",
    violet:
      "border-violet-500/40 bg-violet-500/15 text-violet-800 [[data-theme-mode=dark]_&]:text-violet-300",
    rose: "border-rose-500/40 bg-rose-500/15 text-rose-800 [[data-theme-mode=dark]_&]:text-rose-300",
    teal: "border-teal-500/40 bg-teal-500/15 text-teal-800 [[data-theme-mode=dark]_&]:text-teal-300",
    orange:
      "border-orange-500/40 bg-orange-500/15 text-orange-800 [[data-theme-mode=dark]_&]:text-orange-300",
    fuchsia:
      "border-fuchsia-500/40 bg-fuchsia-500/15 text-fuchsia-800 [[data-theme-mode=dark]_&]:text-fuchsia-300",
    lime: "border-lime-500/40 bg-lime-500/15 text-lime-800 [[data-theme-mode=dark]_&]:text-lime-300",
    cyan: "border-cyan-500/40 bg-cyan-500/15 text-cyan-800 [[data-theme-mode=dark]_&]:text-cyan-300",
  };
  const chips: Record<string, string> = {
    sky: "bg-sky-800",
    emerald: "bg-emerald-800",
    amber: "bg-amber-800",
    violet: "bg-violet-800",
    rose: "bg-rose-800",
    teal: "bg-teal-800",
    orange: "bg-orange-800",
    fuchsia: "bg-fuchsia-800",
    lime: "bg-lime-800",
    cyan: "bg-cyan-800",
  };
  return { face: faces[colour]!, chip: chips[colour]! };
}

export function seatClasses(seat: number): SeatClasses {
  return SEAT_PALETTE[(Math.max(1, seat) - 1) % SEAT_PALETTE.length]!;
}
