import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  defragCells,
  defragHistory,
  ResponsePlaceholderVisual,
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

/** What each lap leans on, so laps differ like a real long turn's phases. */
const FOCUS: ActivityCategory[] = [
  "read",
  "edit",
  "checks",
  "dispatch",
  "browser",
];

/** Activity for the nth step: a fixed walk through the mix, leaning per lap. */
function stepAt(i: number): ActivityCategory {
  const lap = Math.floor(i / cellCount);
  if ((i * 2654435761) % 100 < 40) return FOCUS[lap % FOCUS.length]!;
  return MIX[(i * 7 + lap * 3) % MIX.length]!;
}
function stepsUpTo(length: number): ActivityCategory[] {
  return Array.from({ length }, (_, i) => stepAt(i));
}
/** Steps for `fills` resets, then part way into the next pass. */
const lengthFor = (fills: number) =>
  fills * cellCount + Math.round(cellCount * 0.45);

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
      () => setLength((n) => n + (fast ? 12 : 1)),
      // One move at a time: each step finishes its slide before the next.
      fast ? 1500 : 1800
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
            starts again. The count beside Show progress says how many times,
            and what those laps were made of.
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
      <div className="max-w-md">
        <ResponsePlaceholderVisual
          cells={cells}
          pieces={pieces}
          arrivalKeys={arrivalKeys}
          textLength={categories.filter((c) => c === "write").length * 250}
          onShowProgress={() => undefined}
          fills={fills}
        />
      </div>
    </section>
  );
}
