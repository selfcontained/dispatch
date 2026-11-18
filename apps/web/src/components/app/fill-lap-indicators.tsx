import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ACTIVITY_LABELS,
  type DefragFill,
} from "./chat/turn/response-placeholder";
import {
  ACTIVITY_COLORS,
  type ActivityCategory,
} from "./chat/turn/activity-category";

export type LapStyle = "underline" | "bar" | "laps" | "grid";

type Share = { category: ActivityCategory; count: number };

/** What filled these laps, biggest group first. */
function mixOf(fills: DefragFill[]): Share[] {
  const counts = new Map<ActivityCategory, number>();
  for (const fill of fills)
    for (const category of fill.categories)
      counts.set(category, (counts.get(category) ?? 0) + 1);
  return [...counts]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

/** The few groups worth drawing; the long tail joins "other". */
function topMix(mix: Share[], keep = 4): Share[] {
  if (mix.length <= keep + 1) return mix;
  const head = mix.slice(0, keep).map((s) => ({ ...s }));
  const rest = mix.slice(keep).reduce((n, s) => n + s.count, 0);
  const other = head.find((s) => s.category === "other");
  if (other) {
    other.count += rest;
    return head;
  }
  return [...head, { category: "other", count: rest }];
}

/** Whole blocks per group, like a row of the packed grid. */
function BlockRow({
  mix,
  blocks,
  width,
  height,
}: {
  mix: Share[];
  blocks: number;
  width: number;
  height: number;
}): JSX.Element {
  return (
    <span aria-hidden="true" className="flex shrink-0 gap-px">
      {allocate(mix, blocks).map((category, i) => (
        <span
          key={i}
          className="block rounded-[1px]"
          style={{ width, height, background: color(category) }}
        />
      ))}
    </span>
  );
}

/** Whole cells per category, largest remainder, in group order. */
function allocate(mix: Share[], cells: number): ActivityCategory[] {
  const total = mix.reduce((n, s) => n + s.count, 0);
  const exact = mix.map((s) => ({ ...s, raw: (s.count / total) * cells }));
  const whole = exact.map((s) => Math.floor(s.raw));
  let left = cells - whole.reduce((n, w) => n + w, 0);
  exact
    .map((s, i) => ({ i, frac: s.raw - whole[i]! }))
    .sort((a, b) => b.frac - a.frac)
    .forEach(({ i }) => {
      if (left-- > 0) whole[i]!++;
    });
  return exact.flatMap((s, i) => Array(whole[i]!).fill(s.category));
}

const color = (category: ActivityCategory) =>
  `color-mix(in srgb, ${ACTIVITY_COLORS[category]} 85%, transparent)`;

/** Proportional segments with a hairline between groups. */
function MixBar({
  mix,
  width,
  height,
}: {
  mix: Share[];
  /** Omit to stretch across the chip. */
  width?: number;
  height: number;
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 gap-px overflow-hidden rounded-[1.5px]"
      style={{ width, height }}
    >
      {mix.map((s) => (
        <span
          key={s.category}
          className="block h-full"
          style={{
            flexGrow: s.count,
            flexBasis: 0,
            background: color(s.category),
          }}
        />
      ))}
    </span>
  );
}

function Breakdown({
  fills,
  mix,
}: {
  fills: DefragFill[];
  mix: Share[];
}): JSX.Element {
  const total = mix.reduce((n, s) => n + s.count, 0);
  return (
    <div className="space-y-1 text-[11px]">
      <div className="font-medium">
        Filled {fills.length} {fills.length === 1 ? "time" : "times"}
      </div>
      {mix.slice(0, 5).map((s) => (
        <div key={s.category} className="flex items-center gap-1.5">
          <span
            className="h-2 w-2 rounded-[1.5px]"
            style={{ background: color(s.category) }}
          />
          <span className="flex-1">{ACTIVITY_LABELS[s.category]}</span>
          <span className="tabular-nums text-muted-foreground">
            {Math.round((s.count / total) * 100)}%
          </span>
        </div>
      ))}
    </div>
  );
}

const LAP_CAP = 5;
const GRID_COLS = 10;
const GRID_ROWS = 3;

/** The lap counter, varied by how it shows what each lap was made of. */
export function LapIndicator({
  fills,
  variant,
}: {
  fills: DefragFill[];
  variant: LapStyle;
}): ReactNode {
  if (!fills.length) return null;
  const mix = mixOf(fills);
  const top = topMix(mix);
  const label = `Filled ${fills.length} ${fills.length === 1 ? "time" : "times"}, mostly ${mix
    .slice(0, 2)
    .map((s) => ACTIVITY_LABELS[s.category].toLowerCase())
    .join(" and ")}`;
  const count = <span className="tabular-nums">×{fills.length}</span>;
  let body: ReactNode;
  if (variant === "underline")
    body = (
      <span className="relative inline-flex flex-col items-stretch gap-[2px] px-0.5 pt-px">
        {count}
        <MixBar mix={top} height={2} />
      </span>
    );
  else if (variant === "bar")
    body = (
      <>
        {count}
        <BlockRow mix={top} blocks={12} width={4} height={5} />
      </>
    );
  else if (variant === "laps") {
    const shown = fills.slice(-LAP_CAP);
    body = (
      <>
        {count}
        <span className="flex items-center gap-[3px]">
          {shown.map((fill, i) => (
            <MixBar
              key={fills.length - shown.length + i}
              mix={topMix(mixOf([fill]), 3)}
              width={16}
              height={5}
            />
          ))}
        </span>
      </>
    );
  } else {
    const cells = allocate(top, GRID_COLS * GRID_ROWS);
    body = (
      <>
        {count}
        <span
          aria-hidden="true"
          className="grid gap-px"
          style={{
            gridTemplateColumns: `repeat(${GRID_COLS}, 4px)`,
            gridTemplateRows: `repeat(${GRID_ROWS}, 3px)`,
            gridAutoFlow: "row",
          }}
        >
          {cells.map((category, i) => (
            <span
              key={i}
              className="block rounded-[0.5px]"
              style={{ background: color(category) }}
            />
          ))}
        </span>
      </>
    );
  }
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            tabIndex={0}
            aria-label={label}
            data-testid="chat-response-fill-count"
            className={`inline-flex items-center gap-1.5 rounded-sm border border-border/60 px-1 text-[10px] leading-4 text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${variant === "underline" ? "w-auto py-0" : "py-px"}`}
          >
            {body}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="min-w-40">
          <Breakdown fills={fills} mix={mix} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
