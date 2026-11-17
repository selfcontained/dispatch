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
  ["Combined", "Pack, merge, and gently unify.", true, true],
] as const;

function Grid({
  merge = false,
  unify = false,
  normal = false,
}: {
  merge?: boolean;
  unify?: boolean;
  normal?: boolean;
}) {
  const [packed, setPacked] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(
      () => setPacked((value) => !value),
      normal ? 1500 : 5000
    );
    return () => window.clearInterval(timer);
  }, [normal]);
  return (
    <div data-packed={packed} className="compaction-grid" aria-hidden="true">
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
        return (
          <span
            key={cell.id}
            className="compaction-piece"
            style={
              {
                left: `${start * 3.125}%`,
                top: Math.floor(cell.slot / 32) * 8,
                "--dx": `${(col - start) * 100}%`,
                "--dy": `${(row - Math.floor(cell.slot / 32)) * 8}px`,
                "--piece-color": ACTIVITY_COLORS[cell.rest],
                "--packed-color": unify
                  ? "hsl(var(--status-working))"
                  : ACTIVITY_COLORS[
                      merge ? cells[Math.floor(i / 4) * 4]!.rest : cell.rest
                    ],
                "--packed-width":
                  merge && col % 4 !== 3 && col !== 21
                    ? "101%"
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
            Watch context pack down, then return to the turn.
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
