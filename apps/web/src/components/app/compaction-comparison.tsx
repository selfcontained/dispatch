import { useEffect, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { defragCells } from "./chat/turn/response-placeholder";
import {
  ACTIVITY_COLORS,
  type ActivityCategory,
} from "./chat/turn/activity-category";
import "./compaction-comparison.css";

const cellCount = defragCells("compaction-study", []).length;

/** Same cell identities and collision-free placement as the live defrag. */
function GreenDefrag({
  compacting,
  nearlyFull,
}: {
  compacting: boolean;
  nearlyFull: boolean;
}) {
  const [categories, setCategories] = useState<ActivityCategory[]>(() =>
    nearlyFull ? Array.from({ length: cellCount - 3 }, () => "checks") : []
  );
  useEffect(() => {
    const timer = window.setTimeout(
      () => {
        setCategories((previous) => [
          ...previous,
          compacting
            ? "checks"
            : (["read", "think", "dispatch", "edit", "write"] as const)[
                previous.length % 5
              ]!,
        ]);
      },
      compacting ? 650 + Math.random() * 900 : 1500
    );
    return () => window.clearTimeout(timer);
  }, [compacting, categories]);
  return <DefragPreviewGrid categories={categories} compacting={compacting} />;
}

export function DefragPreviewGrid({
  categories,
  compacting,
}: {
  categories: ActivityCategory[];
  compacting: boolean;
}) {
  const live = defragCells("compaction-study", categories);
  const endpoint = defragCells(
    "compaction-study",
    Array.from({ length: cellCount }, () => "checks")
  );
  return (
    <div
      className={`compaction-frame green-defrag mt-4 ${compacting ? "compaction-active" : ""}`}
    >
      <div className="compaction-grid" aria-hidden="true">
        {Array.from({ length: 128 }, (_, slot) => (
          <span
            key={slot}
            className="compaction-slot"
            style={{
              left: `${(slot % 32) * 3.125}%`,
              top: Math.floor(slot / 32) * 8,
            }}
          />
        ))}
        {live.map((cell) => (
          <span
            key={cell.id}
            className="compaction-piece"
            style={
              {
                left: 0,
                top: 0,
                "--live-x": `${(cell.slot % 32) * 100}%`,
                "--live-y": `${Math.floor(cell.slot / 32) * 8}px`,
                "--dx": `${(endpoint[cell.id]!.slot % 32) * 100}%`,
                "--dy": `${Math.floor(endpoint[cell.id]!.slot / 32) * 8}px`,
                "--piece-color": ACTIVITY_COLORS[cell.category ?? cell.rest],
                "--packed-color": ACTIVITY_COLORS.checks,
                "--packed-width": "calc(100% - 2px)",
              } as CSSProperties
            }
          >
            <span />
          </span>
        ))}
      </div>
      <div className="mt-3 text-xs text-muted-foreground">
        {compacting ? "Compacting context" : "Working"}
      </div>
    </div>
  );
}

export function CompactionComparison() {
  const [compacting, setCompacting] = useState(true);
  const [preset, setPreset] = useState({ id: 0, nearlyFull: false });
  return (
    <section aria-labelledby="compaction-heading" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 id="compaction-heading" className="text-xl font-semibold">
            Compacting context
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            One block at a time turns green. Finish compaction to resume normal
            activity.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              setPreset((value) => ({ id: value.id + 1, nearlyFull: true }));
              setCompacting(true);
            }}
          >
            Load nearly green
          </Button>
          <Button
            variant="default"
            aria-pressed={compacting}
            onClick={() => setCompacting(!compacting)}
          >
            {compacting ? "Finish compaction" : "Start compacting"}
          </Button>
        </div>
      </div>
      <div className="max-w-md">
        <GreenDefrag
          key={preset.id}
          compacting={compacting}
          nearlyFull={preset.nearlyFull}
        />
      </div>
    </section>
  );
}
