import { useRef, useState, type CSSProperties } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { ACTIVITY_COLORS, type ActivityCategory } from "./activity-category";
import { ACTIVITY_LABELS, type DefragFill } from "./response-placeholder";

export type FillShare = { category: ActivityCategory; count: number };

/** What filled these laps, biggest group first. */
export function fillMix(fills: DefragFill[]): FillShare[] {
  const counts = new Map<ActivityCategory, number>();
  for (const fill of fills)
    for (const category of fill.categories)
      counts.set(category, (counts.get(category) ?? 0) + 1);
  return [...counts]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

/** The few groups worth drawing; the long tail joins "other". */
export function topFillMix(mix: FillShare[], keep = 4): FillShare[] {
  if (mix.length <= keep + 1) return mix;
  const head = mix.slice(0, keep).map((share) => ({ ...share }));
  const rest = mix.slice(keep).reduce((n, share) => n + share.count, 0);
  const other = head.find((share) => share.category === "other");
  if (other) {
    other.count += rest;
    return head;
  }
  return [...head, { category: "other", count: rest }];
}

/** Whole blocks per group (largest remainder), in group order. */
export function fillBlocks(
  mix: FillShare[],
  blocks: number
): ActivityCategory[] {
  const total = mix.reduce((n, share) => n + share.count, 0);
  if (!total) return [];
  const exact = mix.map((share) => (share.count / total) * blocks);
  const whole = exact.map(Math.floor);
  let left = blocks - whole.reduce((n, w) => n + w, 0);
  exact
    .map((raw, i) => ({ i, frac: raw - whole[i]! }))
    .sort((a, b) => b.frac - a.frac)
    .forEach(({ i }) => {
      if (left-- > 0) whole[i]!++;
    });
  return mix.flatMap((share, i) => Array(whole[i]!).fill(share.category));
}

const BLOCKS = 12;
const color = (category: ActivityCategory) =>
  `color-mix(in srgb, ${ACTIVITY_COLORS[category]} 85%, transparent)`;

/**
 * How many times a long turn's grid filled and scattered, with a row of
 * blocks grouped by what those laps were made of. Hover, focus or tap for the
 * breakdown.
 */
export function FillCount({
  fills,
  glow,
}: {
  fills: DefragFill[];
  glow?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const openAtPress = useRef(false);
  const mix = fillMix(fills);
  const total = mix.reduce((n, share) => n + share.count, 0);
  const times = `Filled ${fills.length} ${fills.length === 1 ? "time" : "times"}`;
  const label = `${times}, mostly ${mix
    .slice(0, 2)
    .map((share) => ACTIVITY_LABELS[share.category].toLowerCase())
    .join(" and ")}`;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger
          asChild
          // Touch never hovers: a tap on any part of the chip toggles it.
          // The tap also focuses (which opens), so toggle from the state the
          // press started in.
          onPointerDown={() => {
            openAtPress.current = open;
          }}
          onClick={(event) => {
            event.preventDefault();
            setOpen(!openAtPress.current);
          }}
        >
          <span
            role="img"
            tabIndex={0}
            aria-label={label}
            data-testid="chat-response-fill-count"
            className="inline-flex items-center gap-1.5 rounded-sm border border-border/60 px-1 py-px text-[9px] leading-3 text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring cursor-default select-none"
          >
            <span className="tabular-nums">×{fills.length}</span>
            <span aria-hidden="true" className="flex shrink-0 gap-px">
              {fillBlocks(topFillMix(mix), BLOCKS).map((category, i) => (
                <span
                  key={i}
                  data-category={category}
                  data-neon-swatch={glow ? "" : undefined}
                  className="block h-[5px] w-1 rounded-[1px]"
                  style={
                    {
                      background: color(category),
                      "--neon-color": glow
                        ? ACTIVITY_COLORS[category]
                        : undefined,
                    } as CSSProperties
                  }
                />
              ))}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className="min-w-40"
          data-glow={glow ? "halo-soft" : undefined}
        >
          <div className="space-y-1 text-[11px]">
            <div className="font-medium">{times}</div>
            {mix.slice(0, 5).map((share) => (
              <div key={share.category} className="flex items-center gap-1.5">
                <span
                  data-neon-swatch={glow ? "" : undefined}
                  className="h-2 w-2 rounded-[1.5px]"
                  style={
                    {
                      background: color(share.category),
                      "--neon-color": glow
                        ? ACTIVITY_COLORS[share.category]
                        : undefined,
                    } as CSSProperties
                  }
                />
                <span className="flex-1">
                  {ACTIVITY_LABELS[share.category]}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {Math.round((share.count / total) * 100)}%
                </span>
              </div>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
