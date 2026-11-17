import { useEffect, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import {
  ResponsePlaceholder,
  defragCells,
} from "./chat/turn/response-placeholder";
import { ACTIVITY_COLORS } from "./chat/turn/activity-category";
import "./compaction-comparison.css";

const cells = defragCells("compaction-study", []).sort(
  (a, b) => a.slot - b.slot
);
const variants = [
  ["Pack left", "Close the gaps; keep each piece.", false, false],
  ["Merge", "Many pieces become a few longer bars.", true, false],
  ["Unify colour", "Consolidate into a calm green tone.", false, true],
  ["Combined", "Coloured fragments feed a lasting green summary.", true, true],
] as const;

function Grid({
  merge = false,
  unify = false,
}: {
  merge?: boolean;
  unify?: boolean;
}) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setPhase((value) => value + 1), 750);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div
      data-packed="true"
      data-working-shift={phase % 2 === 1}
      className="compaction-grid"
      aria-hidden="true"
    >
      {Array.from({ length: 128 }, (_, i) => (
        <span
          key={i}
          className="compaction-slot"
          style={{ left: `${(i % 32) * 3.125}%`, top: Math.floor(i / 32) * 8 }}
        />
      ))}
      {cells.map((cell, i) => {
        const row = Math.floor(i / 22);
        const col = i % 22;
        const start = cell.slot % 32;
        // Stagger independent row passes so batches keep moving indefinitely.
        const pass = (phase + row * 3) % 12;
        const packedCount = Math.min(22, pass * 3);
        const packed = col < packedCount;
        let position = packed ? col : col + Math.floor((col * 10) / 21);
        const combined = merge && unify;
        const summary = col < 8;
        const intake =
          (phase + Math.floor((col - 8) / 3) * 2 + row * 3 + 48) % 12;
        if (combined) {
          // The summary never disperses. Intake batches disappear into it,
          // then replenish at the right while invisible.
          const travel = Math.min(1, Math.max(0, (intake - 1) / 5));
          position = summary ? col : 28 - 23 * travel + ((col - 8) % 3);
        }
        const absorbed = combined && !summary && (intake === 0 || intake >= 7);
        const finalColor = unify
          ? "hsl(var(--status-working))"
          : ACTIVITY_COLORS[
              merge ? cells[Math.floor(i / 4) * 4]!.rest : cell.rest
            ];
        const finalWidth =
          merge && col % 4 !== 3 && col !== 21 ? "101%" : "calc(100% - 2px)";
        return (
          <span
            key={cell.id}
            className="compaction-piece"
            style={
              {
                left: `${start * 3.125}%`,
                top: Math.floor(cell.slot / 32) * 8,
                "--current-dx": `${(position - start) * 100}%`,
                "--dx": `${(col - start) * 100}%`,
                "--dy": `${(row - Math.floor(cell.slot / 32)) * 8}px`,
                "--piece-color": ACTIVITY_COLORS[cell.rest],
                "--packed-color": finalColor,
                "--packed-width": finalWidth,
                "--current-opacity": absorbed ? 0 : 0.55,
                "--current-color": (combined ? summary || intake >= 5 : packed)
                  ? finalColor
                  : ACTIVITY_COLORS[cell.rest],
                "--current-width": (
                  combined ? summary : packed && col + 1 < packedCount
                )
                  ? finalWidth
                  : "calc(100% - 2px)",
                "--normal-dx": `${(((start + 9) % 32) - start) * 100}%`,
              } as CSSProperties
            }
          >
            <span />
          </span>
        );
      })}
    </div>
  );
}

export function CompactionComparison() {
  const [compacting, setCompacting] = useState(true);
  const [writes, setWrites] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(
      () => setWrites((value) => value + 1),
      1500
    );
    return () => window.clearInterval(timer);
  }, []);
  return (
    <section aria-labelledby="compaction-heading" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 id="compaction-heading" className="text-xl font-semibold">
            Compacting context
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Small batches keep packing while context compacts.
          </p>
        </div>
        <Button
          variant="default"
          aria-pressed={compacting}
          onClick={() => setCompacting(!compacting)}
        >
          {compacting ? "Return to normal turn" : "Start compacting"}
        </Button>
      </div>
      <article className="max-w-md">
        <h3 className="text-sm font-medium">Normal defrag · reference</h3>
        <ResponsePlaceholder
          seed="compaction-study"
          steps={[]}
          textLength={writes * 250}
        />
      </article>
      <div className="grid gap-6 md:grid-cols-2">
        {variants.map(([label, description, merge, unify]) => (
          <article key={label}>
            <div className="flex items-center gap-2">
              <h3 className="font-medium">{label}</h3>
              {label === "Combined" && (
                <span className="text-xs text-status-working">Suggested</span>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            <div
              className={`compaction-frame mt-4 ${compacting ? "compaction-active" : "compaction-normal"}`}
            >
              <Grid merge={merge} unify={unify} />
              <div className="mt-3 text-xs text-muted-foreground">
                {compacting ? "Compacting context" : "Working"}
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
