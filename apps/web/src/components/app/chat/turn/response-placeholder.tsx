import { memo, useMemo, useState } from "react";

import { useChatRowState } from "../chat-row-state";

import type { Step } from "./contracts";
import { responsePieces, type ResponsePiece } from "./response-pieces";
import { ACTIVITY_COLORS, type ActivityCategory } from "./activity-category";

/** Characters of progress text per "writing" piece. */
export const CHARS_PER_PIECE = 250;

const COLS = 32;
const ROWS = 4;
const SLOTS = COLS * ROWS;
const CELL_H = 5;
const ROW_GAP = 3;

/** Small seeded PRNG: random per turn, stable while that turn runs. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++)
    h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

function shuffle<T>(list: T[], r: () => number): T[] {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [list[i], list[j]] = [list[j]!, list[i]!];
  }
  return list;
}

export type DefragCell = {
  id: number;
  slot: number;
  /** The kind of activity this piece is "made of": its faint colour while scattered. */
  rest: ActivityCategory;
  /** The step that placed it in the current pass. */
  step?: number;
  category?: ActivityCategory;
};

/** How often each activity happens in prod, for the pieces' starting mix. */
const SHARES: [ActivityCategory, number][] = [
  ["dispatch", 28],
  ["read", 23],
  ["think", 19],
  ["git", 12],
  ["edit", 6],
  ["browser", 5],
  ["checks", 2.5],
  ["dev", 1],
  ["write", 8],
  ["other", 3.5],
];
const SHARE_TOTAL = SHARES.reduce((n, [, w]) => n + w, 0);
function weighted(r: () => number): ActivityCategory {
  let x = r() * SHARE_TOTAL;
  for (const [c, w] of SHARES) if ((x -= w) < 0) return c;
  return "other";
}

/**
 * The grid for a turn, worked out from all of its steps so far, so a turn
 * opened mid-way shows everything it has done, not just what you watched.
 *
 * The seed picks how full the grid starts (62–76%), where the pieces sit and
 * what each is made of (a mix weighted like real turns), so no two turns
 * look alike. Each step takes one unsorted piece of its own kind into the
 * packed run from the front, at the end of that kind's group, so like
 * colours stay together and the pieces after it shift along a slot; the
 * scattered piece where the run grows moves out to the slot the placed one
 * left. When no piece of that kind is left it takes another unsorted one,
 * whose colour shifts over. Only when every piece is placed does the next
 * step start a new pass: the same pieces scatter again (flying out to new
 * places, each now made of the kind it was placed as) and packing restarts.
 */
export function defragCells(
  seed: string,
  categories: ActivityCategory[]
): DefragCell[] {
  const r = rng(seedOf(seed));
  const count = Math.round(SLOTS * (0.62 + r() * 0.14));
  const cells: DefragCell[] = Array.from({ length: count }, (_, id) => ({
    id,
    slot: 0,
    rest: weighted(r),
  }));
  const passes = Math.floor(Math.max(0, categories.length - 1) / count);
  for (let pass = 0; pass <= passes; pass++) {
    const pr = rng(seedOf(`${seed}:${pass}`));
    const slots = shuffle([...Array(SLOTS).keys()], pr);
    for (const cell of cells) {
      cell.slot = slots[cell.id]!;
      // A piece placed last pass is now made of what it was placed as.
      if (cell.category) cell.rest = cell.category;
      cell.step = undefined;
      cell.category = undefined;
    }
    const unsorted = new Set(cells.map((c) => c.id));
    const bySlot = new Map(cells.map((c) => [c.slot, c]));
    // The packed run from slot 0, kept grouped by kind, groups in the order
    // the pass first met them.
    const run: DefragCell[] = [];
    const first = pass * count;
    const last = Math.min(categories.length, first + count);
    for (let k = first; k < last; k++) {
      const want = categories[k]!;
      const ids = [...unsorted];
      const matching = ids.filter((id) => cells[id]!.rest === want);
      const pool = matching.length ? matching : ids;
      const cell = cells[pool[Math.floor(pr() * pool.length)]!]!;
      unsorted.delete(cell.id);
      cell.rest = want;
      cell.step = k;
      cell.category = want;
      // The run grows by one slot; the scattered piece sitting there moves
      // out to the slot the placed piece left.
      const end = run.length;
      const occupant = bySlot.get(end);
      if (occupant && occupant !== cell) {
        occupant.slot = cell.slot;
        bySlot.set(cell.slot, occupant);
      } else if (!occupant) {
        bySlot.delete(cell.slot);
      }
      // Join the end of its own group; everything after shifts along one.
      let at = run.length;
      for (let i = run.length - 1; i >= 0; i--) {
        if (run[i]!.category === want) {
          at = i + 1;
          break;
        }
      }
      run.splice(at, 0, cell);
      run.forEach((c, i) => {
        c.slot = i;
        bySlot.set(i, c);
      });
    }
  }
  return cells;
}

/**
 * The order a turn's steps (`s`) and writing pieces (`w`) arrived in. A turn
 * opened mid-way has no record of when its text came, so the pieces already
 * written are spread evenly between its steps.
 */
export function blendWrites(steps: number, writes: number): string {
  let out = "";
  for (let i = 0; i < steps; i++) {
    out += "s";
    const due = Math.floor(((i + 1) * writes) / Math.max(1, steps));
    while (out.length - (i + 1) < due) out += "w";
  }
  return out + "w".repeat(Math.max(0, writes - (out.length - steps)));
}

/** What a turn's arrival order means, piece by piece. */
export function sequenceCategories(
  order: string,
  stepCategories: ActivityCategory[]
): ActivityCategory[] {
  let s = 0;
  const out: ActivityCategory[] = [];
  for (const kind of order) {
    if (kind === "w") out.push("write");
    else if (s < stepCategories.length) out.push(stepCategories[s++]!);
  }
  return out;
}

function place(slot: number): string {
  return `translate(${(slot % COLS) * 100}%, ${Math.floor(slot / COLS) * (CELL_H + ROW_GAP)}px)`;
}
const tint = (color: string, alpha: number) =>
  `color-mix(in srgb, ${color} ${alpha}%, transparent)`;
const HEIGHT = ROWS * CELL_H + (ROWS - 1) * ROW_GAP;

/** The empty grid under the blocks: drawn once, never changes. */
const Slots = memo(function Slots(): JSX.Element {
  return (
    <>
      {[...Array(SLOTS).keys()].map((slot) => (
        <span
          key={slot}
          className="absolute left-0 top-0 pr-[2px]"
          style={{
            width: `${100 / COLS}%`,
            height: CELL_H,
            transform: place(slot),
          }}
        >
          <span className="block h-full rounded-[1.5px] bg-muted/40" />
        </span>
      ))}
    </>
  );
});

/**
 * The response placeholder while a turn runs with progress text off: a
 * quiet chasing border round a small "defrag" of the turn. Each step lights
 * a block in the colour of what it did, where the block sits (the read), then
 * moves it to the packed run at the front (the write), so the card fills
 * with the turn's history as it goes. Hovering a block names its step.
 */
export function ResponsePlaceholder({
  seed,
  steps,
  textLength = 0,
  onShowProgress,
}: {
  /** Anything stable per turn: the turn's block id. */
  seed: string;
  steps: Step[];
  /** Characters of progress text the turn has written; every 250 is a piece. */
  textLength?: number;
  /** Shows this turn's progress text in place of the card. */
  onShowProgress?: () => void;
}): JSX.Element {
  const writes = Math.floor(textLength / CHARS_PER_PIECE);
  const [history, setHistory] = useChatRowState<ResponsePiece[] | null>(
    "defrag-pieces",
    null
  );
  const pieces = responsePieces(history, steps, writes);
  const [arrivalKeys, setArrivalKeys] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  if (pieces !== history) {
    const known = new Set(history?.map((piece) => piece.key));
    setArrivalKeys(
      new Set(
        history === null
          ? []
          : pieces
              .filter((piece) => !known.has(piece.key))
              .map((piece) => piece.key)
      )
    );
    setHistory(pieces);
  }
  // Labels/status can change without rebuilding or advancing the grid.
  const categoryKey = pieces.map((piece) => piece.category).join(",");
  const cells = useMemo(
    () =>
      defragCells(
        seed,
        categoryKey ? (categoryKey.split(",") as ActivityCategory[]) : []
      ),
    [seed, categoryKey]
  );
  const newest = pieces.length - 1;

  return (
    <div
      data-testid="chat-response-placeholder"
      className="dispatch-placeholder-chase relative mt-3 w-full max-w-md rounded-lg border border-border/60 bg-muted/10 px-4 py-3.5"
    >
      {/* The status region holds only the picture; the peek control sits
          beside it, so its changing count is never announced. */}
      <div
        role="status"
        aria-label="Preparing response"
        className="relative w-full"
        style={{ height: HEIGHT }}
      >
        <div aria-hidden="true" className="absolute inset-0">
          <Slots />
          {cells.map((c) => {
            const latest = c.step === newest;
            const piece = c.step === undefined ? undefined : pieces[c.step];
            return (
              <span
                key={c.id}
                data-testid={
                  c.category ? "chat-response-placeholder-block" : undefined
                }
                data-category={c.category}
                title={piece?.label}
                className="absolute left-0 top-0 pr-[2px] transition-transform duration-[900ms] ease-in-out motion-reduce:transition-none"
                style={{
                  width: `${100 / COLS}%`,
                  height: CELL_H,
                  transform: place(c.slot),
                  // The newest block lights where it is first, then travels.
                  transitionDelay: latest ? "450ms" : "0ms",
                  zIndex: latest ? 2 : 1,
                }}
              >
                <span
                  key={c.step ?? "rest"}
                  className={`block h-full rounded-[1.5px] transition-[background-color] duration-500 motion-reduce:transition-none ${piece && arrivalKeys.has(piece.key) ? "dispatch-defrag-ack" : ""}`}
                  style={{
                    background: c.category
                      ? tint(ACTIVITY_COLORS[c.category], latest ? 100 : 75)
                      : `color-mix(in hsl, ${ACTIVITY_COLORS[c.rest]} 22%, hsl(var(--muted)))`,
                  }}
                />
              </span>
            );
          })}
        </div>
      </div>
      {onShowProgress && textLength > 0 ? (
        <div className="relative mt-2.5 flex justify-end">
          <button
            type="button"
            onClick={onShowProgress}
            aria-label="Show progress text"
            data-testid="chat-response-show-progress"
            className="rounded-sm text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            Show progress · {formatChars(textLength)}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function formatChars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k chars` : `${n} chars`;
}
