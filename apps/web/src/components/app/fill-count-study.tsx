import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  defragCells,
  defragHistory,
  ResponsePlaceholderVisual,
  type FillStyle,
} from "./chat/turn/response-placeholder";
import { type ActivityCategory } from "./chat/turn/activity-category";

const SEED = "fill-count-study";
const cellCount = defragCells(SEED, []).length;

/** A long turn's rough mix: mostly coordinating, reading and thinking. */
const MIX: ActivityCategory[] = [
  "dispatch",
  "read",
  "think",
  "dispatch",
  "read",
  "git",
  "think",
  "write",
  "dispatch",
  "read",
  "edit",
  "think",
  "browser",
  "dispatch",
  "read",
  "checks",
  "think",
  "other",
  "git",
  "dev",
];

/** Activity for the nth step: a fixed walk through the mix, offset per lap. */
function stepAt(i: number): ActivityCategory {
  const lap = Math.floor(i / cellCount);
  return MIX[(i * 7 + lap * 3) % MIX.length]!;
}
function stepsUpTo(length: number): ActivityCategory[] {
  return Array.from({ length }, (_, i) => stepAt(i));
}
/** Steps for `fills` resets, then part way into the next pass. */
const lengthFor = (fills: number) =>
  fills * cellCount + Math.round(cellCount * 0.45);

const VARIANTS: { style: FillStyle; title: string; note: string }[] = [
  {
    style: "lap",
    title: "1 · Lap counter",
    note: "A small ×n chip beside Show progress.",
  },
  {
    style: "stack",
    title: "2 · Stacked layers",
    note: "One card edge per fill below the card, three then +n.",
  },
  {
    style: "ticks",
    title: "3 · Tick strip",
    note: "One mark per fill along the bottom, in the colours that filled it.",
  },
  {
    style: "ghost",
    title: "4 · Ghost history",
    note: "The last full grid fades behind the new pass. Hover a gap for the count.",
  },
];

const PRESETS = [0, 1, 3, 12];

export function FillCountStudy(): JSX.Element {
  const [length, setLength] = useState(() => lengthFor(0));
  const [playing, setPlaying] = useState(true);
  const [fast, setFast] = useState(false);
  const categories = useMemo(() => stepsUpTo(length), [length]);
  const { cells, fills } = useMemo(
    () => defragHistory(SEED, categories),
    [categories]
  );
  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(
      () => setLength((n) => n + (fast ? 4 : 1)),
      fast ? 60 : 900
    );
    return () => window.clearTimeout(timer);
  }, [playing, fast, length]);
  const pieces = useMemo(
    () =>
      categories.map((category, i) => ({
        key: `fill-${i}`,
        category,
        label: category,
      })),
    [categories]
  );
  const arrivalKeys = useMemo(
    () => new Set([`fill-${categories.length - 1}`]),
    [categories.length]
  );
  const placed = cells.filter((cell) => cell.category).length;
  return (
    <section aria-labelledby="fill-count-heading" className="space-y-6">
      <div className="space-y-3">
        <div>
          <h2 id="fill-count-heading" className="text-xl font-semibold">
            Fill count
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Each time every block is packed, the next step scatters the grid and
            starts again. These show how many times that has happened.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={() => setPlaying((v) => !v)}>
            {playing ? "Pause" : "Play"}
          </Button>
          <Button
            variant={fast ? "default" : "ghost"}
            aria-pressed={fast}
            onClick={() => {
              setFast((v) => !v);
              setPlaying(true);
            }}
          >
            Fast-forward
          </Button>
          <Button
            variant="ghost"
            onClick={() => setLength((fills.length + 1) * cellCount + 1)}
          >
            Skip to next fill
          </Button>
          <div
            role="group"
            aria-label="Jump to fills"
            className="flex items-center gap-1"
          >
            <span className="mr-1 text-xs text-muted-foreground">Fills</span>
            {PRESETS.map((n) => (
              <Button
                key={n}
                size="sm"
                variant={fills.length === n ? "default" : "ghost"}
                onClick={() => {
                  setLength(lengthFor(n));
                  setFast(false);
                  setPlaying(false);
                }}
              >
                {n}
              </Button>
            ))}
          </div>
        </div>
        <p className="text-xs tabular-nums text-muted-foreground" role="status">
          {fills.length} {fills.length === 1 ? "fill" : "fills"} · {placed}/
          {cellCount} packed · step {categories.length}
        </p>
      </div>
      <div className="grid gap-x-8 gap-y-8 md:grid-cols-2">
        {VARIANTS.map((variant) => (
          <figure
            key={variant.style}
            data-testid={`fill-variant-${variant.style}`}
            className="min-w-0"
          >
            <figcaption>
              <div className="text-sm font-medium">{variant.title}</div>
              <div className="text-xs text-muted-foreground">
                {variant.note}
              </div>
            </figcaption>
            <ResponsePlaceholderVisual
              cells={cells}
              pieces={pieces}
              arrivalKeys={arrivalKeys}
              textLength={categories.filter((c) => c === "write").length * 250}
              onShowProgress={() => undefined}
              fills={fills}
              fillStyle={variant.style}
            />
          </figure>
        ))}
      </div>
    </section>
  );
}
