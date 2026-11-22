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
    (a, b) =>
      (a.createdAt ?? "").localeCompare(b.createdAt ?? "") ||
      a.id.localeCompare(b.id)
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
export type SeatClasses = {
  face: string;
  chip: string;
  color: string;
  ink: string;
};

// The seat variables in index.css carry each theme mode's text shade.
// Spelled out per colour so Tailwind sees every class it must emit.
function seatAccent(colour: string): SeatClasses {
  const faces: Record<string, string> = {
    sky: "border-seat-1/line bg-seat-1/tint text-seat-1-text",
    emerald: "border-seat-2/line bg-seat-2/tint text-seat-2-text",
    amber: "border-seat-3/line bg-seat-3/tint text-seat-3-text",
    violet: "border-seat-4/line bg-seat-4/tint text-seat-4-text",
    rose: "border-seat-5/line bg-seat-5/tint text-seat-5-text",
    teal: "border-seat-6/line bg-seat-6/tint text-seat-6-text",
    orange: "border-seat-7/line bg-seat-7/tint text-seat-7-text",
    fuchsia: "border-seat-8/line bg-seat-8/tint text-seat-8-text",
    lime: "border-seat-9/line bg-seat-9/tint text-seat-9-text",
    cyan: "border-seat-10/line bg-seat-10/tint text-seat-10-text",
  };
  const chips: Record<string, string> = {
    sky: "bg-seat-1-ink",
    emerald: "bg-seat-2-ink",
    amber: "bg-seat-3-ink",
    violet: "bg-seat-4-ink",
    rose: "bg-seat-5-ink",
    teal: "bg-seat-6-ink",
    orange: "bg-seat-7-ink",
    fuchsia: "bg-seat-8-ink",
    lime: "bg-seat-9-ink",
    cyan: "bg-seat-10-ink",
  };
  const paint: Record<string, [string, string]> = {
    sky: ["#0ea5e9", "#075985"],
    emerald: ["#10b981", "#065f46"],
    amber: ["#f59e0b", "#92400e"],
    violet: ["#8b5cf6", "#5b21b6"],
    rose: ["#f43f5e", "#9f1239"],
    teal: ["#14b8a6", "#115e59"],
    orange: ["#f97316", "#9a3412"],
    fuchsia: ["#d946ef", "#86198f"],
    lime: ["#84cc16", "#3f6212"],
    cyan: ["#06b6d4", "#155e75"],
  };
  return {
    face: faces[colour]!,
    chip: chips[colour]!,
    color: paint[colour]![0],
    ink: paint[colour]![1],
  };
}

export function seatClasses(seat: number): SeatClasses {
  return SEAT_PALETTE[(Math.max(1, seat) - 1) % SEAT_PALETTE.length]!;
}
