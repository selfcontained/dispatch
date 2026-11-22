import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  defragHistory,
  ResponsePlaceholderVisual,
} from "./chat/turn/response-placeholder";
import type { ActivityCategory } from "./chat/turn/activity-category";

const categories: ActivityCategory[] = [
  "read",
  "think",
  "git",
  "edit",
  "browser",
  "checks",
  "dispatch",
  "write",
  "dev",
  "other",
];
const treatments = [
  {
    glow: "tube",
    title: "Tight tube",
    description: "Bright core, crisp edge and a tight halo.",
  },
  {
    glow: "halo",
    title: "Diffuse halo",
    description: "A wider wash of category-colored light.",
  },
  {
    glow: "bloom",
    title: "Landing bloom",
    description: "Flares on landing, then holds a lit edge.",
  },
] as const;

export function NeonGlowPreview() {
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [replay, setReplay] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 2200);
    return () => window.clearInterval(timer);
  }, [playing]);
  return (
    <section aria-label="Neon glow comparison" className="min-w-0 space-y-4">
      <h2 className="text-xl font-semibold">Three neon glows</h2>
      <p className="text-sm text-muted-foreground">
        Preview only. Compare the same placements in sparse and dense activity.
        Pause to inspect the settled glow; hover or tap a placed group for its
        category.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => {
            setTick(0);
            setReplay((value) => value + 1);
            setPlaying(true);
          }}
        >
          Replay glows
        </Button>
        <Button variant="ghost" onClick={() => setPlaying((value) => !value)}>
          {playing ? "Pause glows" : "Play glows"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setPlaying(false);
            setTick((value) => value + 1);
          }}
        >
          Next placement
        </Button>
      </div>
      <p className="text-xs text-muted-foreground" role="status">
        {playing
          ? "Playing · one placement every 2.2 seconds"
          : "Paused · settled glow remains lit"}{" "}
        · Placement {tick}
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {treatments.map(({ glow, title, description }) => (
          <div
            key={`${glow}-${replay}`}
            className="grid min-w-0 grid-rows-subgrid row-span-4 gap-y-3 rounded-lg border border-border p-3"
            data-treatment={glow}
          >
            <h3 className="font-medium">{title}</h3>
            <p className="text-xs text-muted-foreground">{description}</p>
            {[
              { label: "Sparse", base: 4 },
              { label: "Dense", base: 72 },
            ].map(({ label, base }) => {
              const pieces = Array.from({ length: base + tick }, (_, i) => ({
                key: `neon-${i}`,
                category: categories[i % categories.length]!,
                label: `Activity ${i + 1}`,
              }));
              const { cells, fills } = defragHistory(
                "neon-comparison",
                pieces.map((piece) => piece.category)
              );
              return (
                <div key={label} className="min-w-0">
                  <h4 className="text-xs text-muted-foreground">{label}</h4>
                  <ResponsePlaceholderVisual
                    glow={glow}
                    cells={cells}
                    fills={fills}
                    pieces={pieces}
                    arrivalKeys={
                      tick ? new Set([pieces.at(-1)!.key]) : undefined
                    }
                    summary={`${pieces.length} activities`}
                  />
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
