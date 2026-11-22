import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  defragCells,
  ResponsePlaceholderVisual,
} from "./chat/turn/response-placeholder";
import { type ActivityCategory } from "./chat/turn/activity-category";

const SEED = "compaction-study";

/** Same cell identities and collision-free placement as the live defrag. */
function GreenDefrag({
  compacting,
  nearlyFull,
}: {
  compacting: boolean;
  nearlyFull: boolean;
}) {
  const [categories, setCategories] = useState<ActivityCategory[]>([]);
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
  return (
    <DefragPreviewGrid
      categories={categories}
      compacting={compacting}
      nearlyFull={nearlyFull}
    />
  );
}

export function DefragPreviewGrid({
  categories,
  compacting,
  nearlyFull = false,
}: {
  categories: ActivityCategory[];
  compacting: boolean;
  nearlyFull?: boolean;
}) {
  const [seenCount, setSeenCount] = useState(categories.length);
  const [arrivalKeys, setArrivalKeys] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  if (seenCount !== categories.length) {
    setArrivalKeys(
      new Set(
        Array.from(
          { length: Math.max(0, categories.length - seenCount) },
          (_, i) => `preview-${seenCount + i}`
        )
      )
    );
    setSeenCount(categories.length);
  }
  const pieces = useMemo(
    () =>
      categories.map((category, i) => ({
        key: `preview-${i}`,
        category,
        label: category,
      })),
    [categories]
  );
  const buildLayout = useCallback(
    (slots: number) => {
      const count = defragCells(SEED, [], undefined, slots).length;
      const prefilled = nearlyFull
        ? Array.from({ length: count - 3 }, (_, i) => ({
            key: `preset-${i}`,
            category: "checks" as const,
            label: "checks",
          }))
        : [];
      const activity = [...prefilled, ...pieces];
      return {
        pieces: activity,
        cells: defragCells(
          SEED,
          activity.map((piece) => piece.category),
          undefined,
          slots
        ),
        reducedCells: compacting
          ? defragCells(
              SEED,
              Array.from({ length: count }, () => "checks"),
              undefined,
              slots
            )
          : undefined,
      };
    },
    [pieces, compacting, nearlyFull]
  );
  return (
    <ResponsePlaceholderVisual
      buildLayout={buildLayout}
      arrivalKeys={arrivalKeys}
      pieces={pieces}
      statusLabel={compacting ? "Compacting context" : "Preparing response"}
    />
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
        <p className="mt-2 text-xs text-muted-foreground">
          {compacting ? "Compacting context" : "Working"}
        </p>
      </div>
    </section>
  );
}
