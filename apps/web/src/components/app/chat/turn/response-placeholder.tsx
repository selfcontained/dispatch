import "./neon-preview.css";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { useChatRowState } from "../chat-row-state";
import { cn } from "@/lib/utils";
import { useActivitySum } from "./activity-summary";

import type { Step } from "./contracts";
import { activitySteps } from "./activity-steps";
import { activeStepLabel, runningTurnVerb } from "./registry";
import { responsePieces, type ResponsePiece } from "./response-pieces";
import { ACTIVITY_COLORS, type ActivityCategory } from "./activity-category";
import { FillCount } from "./fill-count";

export const ACTIVITY_LABELS: Record<ActivityCategory, string> = {
  dispatch: "Coordinating agents",
  read: "Reading files",
  think: "Thinking",
  git: "Git",
  browser: "Browsing",
  edit: "Editing",
  checks: "Checks and tests",
  dev: "System tools",
  write: "Writing response",
  other: "Other activity",
};

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
  categories: ActivityCategory[],
  repackAt: ReadonlySet<number> = new Set()
): DefragCell[] {
  return defragHistory(seed, categories, repackAt).cells;
}

/** One time the grid filled up and scattered for a new pass. */
export type DefragFill = {
  /** The packed run when it filled, front to back. */
  categories: ActivityCategory[];
};

/** The grid plus every fill it went through to get there. */
export function defragHistory(
  seed: string,
  categories: ActivityCategory[],
  repackAt: ReadonlySet<number> = new Set()
): { cells: DefragCell[]; fills: DefragFill[] } {
  const fills: DefragFill[] = [];
  const r = rng(seedOf(seed));
  const count = Math.round(SLOTS * (0.62 + r() * 0.14));
  const cells: DefragCell[] = Array.from({ length: count }, (_, id) => ({
    id,
    slot: 0,
    rest: weighted(r),
  }));
  let pass = -1;
  let pr = rng(0);
  let unsorted = new Set<number>();
  let bySlot = new Map<number, DefragCell>();
  let run: DefragCell[] = [];
  const beginPass = (scatter: boolean) => {
    pr = rng(seedOf(`${seed}:${++pass}`));
    const slots = shuffle([...Array(SLOTS).keys()], pr);
    for (const cell of cells) {
      if (scatter) cell.slot = slots[cell.id]!;
      if (cell.category) cell.rest = cell.category;
      cell.step = undefined;
      cell.category = undefined;
    }
    unsorted = new Set(cells.map((c) => c.id));
    bySlot = new Map(cells.map((c) => [c.slot, c]));
    run = [];
  };
  beginPass(true);
  for (let k = 0; k < categories.length; k++) {
    // Compaction starts sorting from the front without teleporting the grid.
    if (repackAt.has(k)) beginPass(false);
    else if (run.length === count) {
      fills.push({ categories: run.map((c) => c.category!) });
      beginPass(true);
    }
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
  return { cells, fills };
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

/**
 * A slot's offset in the grid. The column is a fraction of the grid's width
 * (`cqw`), not a percentage of the cell's own box: WebKit resolves a
 * percentage translate against the cell's pixel-snapped width, so a move's
 * animated end and its resting position disagreed by a pixel or more and the
 * block snapped sideways as it landed. `cqw` is an absolute length once
 * computed, so every frame and the resting place use the same number.
 */
export function place(slot: number): string {
  return `translate(calc(${slot % COLS} * 100cqw / ${COLS}), ${Math.floor(slot / COLS) * (CELL_H + ROW_GAP)}px)`;
}
const tint = (color: string, alpha: number) =>
  `color-mix(in srgb, ${color} ${alpha}%, transparent)`;
const HEIGHT = ROWS * CELL_H + (ROWS - 1) * ROW_GAP;

// A tiled mask draws all 128 rounded slots in a single paint layer.
const slotMask = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100%25' height='100%25'%3E%3Crect style='width:calc(100%25 - 2px)' height='${CELL_H}' rx='1.5'/%3E%3C/svg%3E")`;
const slotStyle: CSSProperties = {
  maskImage: slotMask,
  maskSize: `${100 / COLS}% ${CELL_H + ROW_GAP}px`,
  maskRepeat: "repeat",
};

/**
 * The response placeholder while a turn runs with progress text off: a
 * quiet chasing border round a small "defrag" of the turn. Each step lights
 * a block in the colour of what it did, where the block sits (the read), then
 * moves it to the packed run at the front (the write), so the card fills
 * with the turn's history as it goes. Hovering a coloured block names its activity category.
 */
export function ResponsePlaceholder({
  seed,
  steps,
  textLength = 0,
  lastProgressAt,
  animationPaused = false,
  turnStartedAt,
  reserveSummary = false,
}: {
  /** Hold the activity-counts line's room before there is anything to count. */
  reserveSummary?: boolean;
  /** Anything stable per turn: the turn's block id. */
  seed: string;
  steps: Step[];
  lastProgressAt?: number;
  /** Design Lab playback control; real turns follow the engine's steps. */
  animationPaused?: boolean;
  /** Wall-clock start of a live turn, used to leave its arrival quiet. */
  turnStartedAt?: number;
  /** Characters of progress text the turn has written; every 250 is a piece. */
  textLength?: number;
}): JSX.Element {
  // Let the post fade and scroll into view before mounting the moving grid.
  // An already-running turn reopened from history is ready immediately.
  const quietUntil = (turnStartedAt ?? 0) + 850;
  const [quiet, setQuiet] = useState(() => quietUntil > Date.now());
  useEffect(() => {
    if (!quiet) return;
    const timer = window.setTimeout(
      () => setQuiet(false),
      Math.min(850, Math.max(0, quietUntil - Date.now()))
    );
    return () => window.clearTimeout(timer);
  }, [quiet, quietUntil]);
  const compactionId = activitySteps(steps).find(
    (step) => step.kind === "compaction" && step.status === "running"
  )?.id;
  const writes = Math.floor(textLength / CHARS_PER_PIECE);
  const [history, setHistory] = useChatRowState<ResponsePiece[] | null>(
    "defrag-pieces",
    null
  );
  const [pulseCount, setPulseCount] = useChatRowState(
    "defrag-compaction-pulses",
    0
  );
  useEffect(() => {
    if (!compactionId || animationPaused) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => {
          setPulseCount((previous) => previous + 1);
          schedule();
        },
        650 + Math.random() * 900
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, [compactionId, animationPaused, setPulseCount]);
  const thinking =
    runningTurnVerb(steps, undefined, lastProgressAt) === "thinking";
  const implicitThinking = thinking && !activeStepLabel(steps);
  const [thinkingPhase, setThinkingPhase] = useChatRowState(
    "defrag-thinking-phase",
    { active: false, sequence: 0, synthetic: false }
  );
  const nextPhase =
    thinking === thinkingPhase.active
      ? thinkingPhase
      : {
          active: thinking,
          sequence: thinkingPhase.sequence + (thinking ? 1 : 0),
          synthetic: implicitThinking,
        };
  if (nextPhase !== thinkingPhase) setThinkingPhase(nextPhase);
  const recordedPulses =
    history?.filter((piece) => piece.key.startsWith("compaction-pulse:"))
      .length ?? 0;
  const pendingPulses: ResponsePiece[] = Array.from(
    { length: Math.max(0, pulseCount - recordedPulses) },
    (_, i) => ({
      key: `compaction-pulse:${recordedPulses + i + 1}`,
      category: "checks",
      label: "Compacting context",
      compaction: true,
    })
  );
  // Apply timer events before new engine events, including a compaction's end.
  const withPulses = pendingPulses.length
    ? [...(history ?? []), ...pendingPulses]
    : history;
  const pieces = responsePieces(
    withPulses,
    steps,
    writes,
    implicitThinking && nextPhase.synthetic
      ? `thinking:${nextPhase.sequence}`
      : undefined
  );
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
  const categoryKey = pieces
    .map((piece) => `${piece.compaction ? "compact:" : ""}${piece.category}`)
    .join(",");
  const { cells, fills } = useMemo(() => {
    const modes = categoryKey ? categoryKey.split(",") : [];
    const starts = new Set(
      modes.flatMap((mode, i) =>
        mode.startsWith("compact:") && !modes[i - 1]?.startsWith("compact:")
          ? [i]
          : []
      )
    );
    return defragHistory(
      seed,
      modes.map((mode) => mode.replace("compact:", "") as ActivityCategory),
      starts
    );
  }, [seed, categoryKey]);
  const reducedCells = useMemo(
    () =>
      compactionId
        ? defragCells(
            seed,
            Array.from({ length: defragCells(seed, []).length }, () => "checks")
          )
        : undefined,
    [seed, compactionId]
  );
  const sum = useActivitySum(steps);
  return (
    <ResponsePlaceholderVisual
      cells={cells}
      quiet={quiet}
      fills={fills}
      pieces={pieces}
      arrivalKeys={arrivalKeys}
      textLength={textLength}
      summary={sum}
      reserveSummary={reserveSummary}
      reducedCells={reducedCells}
      statusLabel={compactionId ? "Compacting context" : "Preparing response"}
    />
  );
}

export type DefragGlow = "halo" | "halo-tight" | "halo-soft";

/** Shared presentation for live turns and the Design Studio. */
export function ResponsePlaceholderVisual({
  cells,
  quiet = false,
  pieces,
  arrivalKeys,
  textLength = 0,
  onShowProgress,
  summary,
  reserveSummary = false,
  reducedCells,
  statusLabel = "Preparing response",
  fills = [],
  glow = "halo-soft",
}: {
  glow?: DefragGlow;
  /** What the turn has done so far, in place of the progress link. */
  summary?: string;
  reserveSummary?: boolean;
  cells: DefragCell[];
  quiet?: boolean;
  pieces: ResponsePiece[];
  arrivalKeys?: ReadonlySet<string>;
  textLength?: number;
  onShowProgress?: () => void;
  reducedCells?: DefragCell[];
  statusLabel?: string;
  /** Earlier passes that filled the grid and scattered it again. */
  fills?: DefragFill[];
}): JSX.Element {
  const newest = pieces.length - 1;
  const gridRef = useRef<HTMLDivElement>(null);
  const [label, setLabel] = useState<string | null>(null);
  // A pass can move the group away from a stationary mouse or touch point.
  // Dismiss before the new layout travels rather than keeping a stale anchor.
  useEffect(() => setLabel(null), [cells, reducedCells]);
  useEffect(() => {
    if (!label) return;
    const dismiss = (event: PointerEvent) => {
      if (!gridRef.current?.contains(event.target as Node)) setLabel(null);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [label]);
  const [anchor, setAnchor] = useState({
    left: 0,
    top: 0,
    width: 0,
    color: "",
  });
  const labelAt = (event: { clientX: number; clientY: number }) => {
    const grid = gridRef.current;
    if (!grid) return null;
    const reduced =
      reducedCells &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const candidates = Array.from(
      grid.querySelectorAll<HTMLElement>("[data-defrag-cell]")
    )
      .filter((cell) => reduced || cell.dataset.category)
      .map((cell) => ({ cell, rect: cell.getBoundingClientRect() }));
    const hit = candidates.find(
      ({ rect }) =>
        event.clientX >= rect.left &&
        event.clientX < rect.right &&
        event.clientY >= rect.top - ROW_GAP / 2 &&
        event.clientY < rect.bottom + ROW_GAP / 2
    );
    if (!hit) return null;
    const category = reduced
      ? "checks"
      : (hit.cell.dataset.category as ActivityCategory);
    const compaction = reduced || !!hit.cell.dataset.compaction;
    const group = candidates.filter(
      ({ cell, rect }) =>
        Math.abs(rect.top - hit.rect.top) < 1 &&
        (reduced || cell.dataset.category === category) &&
        (reduced || !!cell.dataset.compaction === compaction)
    );
    const left = Math.min(...group.map(({ rect }) => rect.left));
    const right = Math.max(...group.map(({ rect }) => rect.right));
    const bounds = grid.getBoundingClientRect();
    setAnchor({
      left: left - bounds.left,
      top: hit.rect.top - bounds.top,
      width: right - left,
      color: ACTIVITY_COLORS[category],
    });
    return compaction ? "Compaction" : ACTIVITY_LABELS[category];
  };

  return (
    <div
      data-glow={glow}
      data-testid="chat-response-placeholder"
      className={`dispatch-placeholder ${quiet ? "" : "dispatch-placeholder-chase"} relative mt-3 w-full max-w-md rounded-lg border border-border/60 bg-muted/10 overflow-clip px-2.5 py-2 ${reducedCells ? "dispatch-defrag-reduced" : ""}`}
    >
      {/* The status region holds only the picture; the peek control sits
          beside it, so its changing count is never announced. */}
      <TooltipProvider>
        <Tooltip
          open={label !== null}
          onOpenChange={(open) => {
            if (!open) setLabel(null);
          }}
        >
          <div
            ref={gridRef}
            onClick={(event) => event.preventDefault()}
            onPointerMove={(event) => {
              if (event.pointerType !== "touch") setLabel(labelAt(event));
            }}
            onPointerLeave={(event) => {
              if (event.pointerType !== "touch") setLabel(null);
            }}
            onPointerUp={(event) => {
              if (event.pointerType === "touch") setLabel(labelAt(event));
            }}
            role="status"
            aria-label={statusLabel}
            className="relative w-full"
            // The container `place()` measures columns against.
            style={{ height: HEIGHT, containerType: "inline-size" }}
          >
            <TooltipTrigger asChild>
              <span
                aria-hidden="true"
                className="pointer-events-none absolute"
                style={{
                  left: anchor.left,
                  top: anchor.top,
                  width: anchor.width,
                  height: CELL_H,
                }}
              />
            </TooltipTrigger>
            <div aria-hidden="true" className="absolute inset-0">
              <div className="absolute inset-0 bg-muted/40" style={slotStyle} />
              <div className="dispatch-placeholder-colors absolute inset-0">
                {!quiet &&
                  cells.map((c) => {
                    const latest = c.step === newest;
                    const piece =
                      c.step === undefined ? undefined : pieces[c.step];
                    const packed = reducedCells?.[c.id];
                    const packedColor = packed
                      ? ACTIVITY_COLORS[packed.category ?? packed.rest]
                      : undefined;
                    return (
                      <span
                        key={c.id}
                        data-defrag-cell=""
                        data-testid={
                          c.category
                            ? "chat-response-placeholder-block"
                            : undefined
                        }
                        data-category={c.category}
                        data-compaction={piece?.compaction || undefined}
                        className="absolute left-0 top-0 pr-[2px] transition-transform duration-[900ms] ease-in-out motion-reduce:transition-none"
                        style={
                          {
                            "--neon-color": c.category
                              ? ACTIVITY_COLORS[c.category]
                              : undefined,
                            width: `${100 / COLS}%`,
                            height: CELL_H,
                            transform: place(c.slot),
                            // The newest block lights where it is first, then travels.
                            transitionDelay: latest ? "450ms" : "0ms",
                            zIndex: latest ? 2 : 1,
                            "--defrag-packed-transform": packed
                              ? place(packed.slot)
                              : undefined,
                            "--defrag-packed-color": packedColor
                              ? tint(packedColor, 75)
                              : undefined,
                            "--defrag-packed-tone": packedColor,
                          } as CSSProperties
                        }
                      >
                        <span
                          key={c.step ?? "rest"}
                          data-neon-swatch={
                            c.category || packed ? "" : undefined
                          }
                          className={`block h-full rounded-[1.5px] transition-[background-color] duration-500 motion-reduce:transition-none ${piece && arrivalKeys?.has(piece.key) ? "dispatch-defrag-ack" : ""}`}
                          style={{
                            background: c.category
                              ? tint(
                                  ACTIVITY_COLORS[c.category],
                                  latest ? 100 : 75
                                )
                              : `color-mix(in hsl, ${ACTIVITY_COLORS[c.rest]} 22%, hsl(var(--muted)))`,
                          }}
                        />
                      </span>
                    );
                  })}
              </div>
            </div>
          </div>
          {label && (
            <TooltipContent
              side="top"
              data-glow={glow}
              data-neon-tooltip=""
              style={
                {
                  "--neon-color": anchor.color,
                  color: anchor.color,
                  borderColor: tint(anchor.color, 45),
                  background: `color-mix(in srgb, ${anchor.color} 12%, hsl(var(--card)))`,
                } as CSSProperties
              }
            >
              {label}
            </TooltipContent>
          )}
        </Tooltip>
      </TooltipProvider>
      {(onShowProgress && textLength > 0) ||
      summary ||
      reserveSummary ||
      fills.length > 0 ? (
        <div className="relative mt-2.5 flex min-h-[14px] items-center gap-2">
          {fills.length > 0 && <FillCount fills={fills} glow={glow} />}
          {summary || reserveSummary ? (
            // The line's room is held from the start, so the counts fading in
            // move nothing.
            <span
              className={cn(
                "ml-auto min-w-0 truncate text-[11px] tabular-nums text-muted-foreground transition-opacity duration-300 motion-reduce:transition-none",
                !summary && "opacity-0"
              )}
              data-testid="chat-response-activity-counts"
            >
              {summary || "\u00a0"}
            </span>
          ) : null}
          {!summary && onShowProgress && textLength > 0 && (
            <button
              type="button"
              onClick={onShowProgress}
              aria-label="Show progress text"
              data-testid="chat-response-show-progress"
              className="ml-auto rounded-sm text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              Show progress · {formatChars(textLength)}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function formatChars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k chars` : `${n} chars`;
}
