// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit):
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Check, ChevronDown, ChevronRight, RotateCcw, X } from "lucide-react";

import { cn } from "@/lib/utils";

import type { Step, StepStatus } from "./contracts";
import { formatStepDuration } from "@/components/app/harness/format";
import { arrive, DURATION, rowDelay, rowVariants } from "./motion";
import { hasDetail, stepLabel, stepSummary, toolName } from "./registry";
import { StepDetail } from "./step-detail";
import { useStreamTicker } from "@/components/app/harness/use-stream-ticker";

/** Matches the fold's transition duration. */
const FOLD_MS = DURATION.base * 1000;

const STATUS_ARIA: Record<StepStatus, string> = {
  running: "running",
  ok: "completed",
  retry: "retrying",
  error: "failed",
  skipped: "skipped",
};

const ROW_CLASS =
  "flex w-full items-center gap-[9px] py-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-status-working/50";

/** One step in the activity rail: glyph, label, summary, duration, toggle. */
export function StepRow({
  step,
  open,
  onToggle,
  maskClass,
  depth = 0,
  index = 0,
}: {
  step: Step;
  open: boolean;
  onToggle: () => void;
  /** Background class that hides the rail line behind the glyph. */
  maskClass: string;
  /** 0 at the rail's top level; children render one deeper. */
  depth?: number;
  /** This row's slot within its landing burst; staggers its entrance. */
  index?: number;
}): JSX.Element {
  const running = step.status === "running";
  // Only a step with something underneath gets a toggle.
  const expandable = hasDetail(step);
  const expanded = expandable && open;
  // The body stays mounted while the rows collapse, or the fold snaps
  // shut instead of animating; it unmounts once the transition ends (or
  // after its duration, for a reduced-motion run that fires no event).
  const [mounted, setMounted] = useState(expanded);
  // What the fold shows is what was open: on the settle commit the step
  // already carries its result, and rendering that would pop the body to
  // the settled height before easing to zero. The last expanded render
  // is kept and shown until the fold ends.
  const shown = useRef(step);
  if (expanded) shown.current = step;
  useEffect(() => {
    if (expanded) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), FOLD_MS + 50);
    return () => clearTimeout(timer);
  }, [expanded]);
  const label = stepLabel(step);
  const server = step.label ? toolName(step.label).server : undefined;
  const summary = running ? undefined : stepSummary(step);
  const inner = (
    <>
      <StatusGlyph status={step.status} maskClass={maskClass} />
      <span
        className={cn(
          "shrink-0 truncate text-[12px]",
          running
            ? "font-medium text-status-working"
            : "font-normal text-foreground"
        )}
      >
        {label}
        {server ? (
          <span className="ml-1 text-[10px] text-muted-foreground">
            {server}
          </span>
        ) : null}
        {step.attempt && step.attempt > 0 ? (
          <span className="ml-1 text-muted-foreground">·{step.attempt}</span>
        ) : null}
      </span>
      {running ? (
        <RunningDots />
      ) : summary ? (
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          · {summary}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      {step.durMs ? (
        <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
          {formatStepDuration(step.durMs)}
        </span>
      ) : running ? (
        <LiveDuration startedAt={step.startedAt} />
      ) : null}
      <span
        aria-hidden="true"
        className={cn(
          "w-2 shrink-0 text-[9px] text-muted-foreground/70",
          !expandable && "invisible"
        )}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
      </span>
    </>
  );
  return (
    <motion.div
      variants={rowVariants}
      initial="hidden"
      animate="shown"
      transition={{ ...arrive(), delay: rowDelay(index) }}
      role="listitem"
      aria-live={running ? "polite" : undefined}
      data-testid="harness-step"
      data-depth={depth}
      data-expandable={expandable ? "true" : "false"}
    >
      {expandable ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`${label}, ${STATUS_ARIA[step.status]}`}
          className={ROW_CLASS}
        >
          {inner}
        </button>
      ) : (
        <div
          className={cn(ROW_CLASS, "cursor-default")}
          aria-label={`${label}, ${STATUS_ARIA[step.status]}`}
        >
          {inner}
        </div>
      )}
      {/* The body's height animates 0 to auto on the fold's motion token. */}
      <motion.div
        animate={{ height: expanded ? "auto" : 0 }}
        transition={arrive()}
        style={{ overflow: "hidden" }}
        onAnimationComplete={() => {
          if (!expanded) setMounted(false);
        }}
      >
        {expanded ? (
          <StepDetail step={step} depth={depth} />
        ) : mounted ? (
          <StepDetail step={shown.current} depth={depth} />
        ) : null}
      </motion.div>
    </motion.div>
  );
}

export function StatusGlyph({
  status,
  maskClass,
}: {
  status: StepStatus;
  maskClass: string;
}): JSX.Element {
  const { braille } = useStreamTicker(status === "running");
  const base = cn(
    "z-10 flex w-3 shrink-0 items-center justify-center text-[12px] leading-none",
    maskClass
  );
  switch (status) {
    case "running":
      return (
        <span className={cn(base, "text-status-working")} aria-hidden="true">
          {braille}
        </span>
      );
    case "ok":
      return (
        <motion.span
          className={cn(base, "font-bold text-status-done")}
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={arrive(DURATION.fast)}
          aria-hidden="true"
        >
          <Check className="h-3 w-3" strokeWidth={2.5} />
        </motion.span>
      );
    case "retry":
      return (
        <span className={cn(base, "text-status-waiting")} aria-hidden="true">
          <RotateCcw className="h-3 w-3" />
        </span>
      );
    case "error":
      return (
        <span
          className={cn(base, "font-bold text-status-blocked")}
          aria-hidden="true"
        >
          <X className="h-3 w-3" strokeWidth={2.5} />
        </span>
      );
    case "skipped":
      return (
        <span
          className={cn(base, "text-muted-foreground/50")}
          aria-hidden="true"
        >
          ·
        </span>
      );
    default:
      return (
        <span
          className={cn(base, "text-muted-foreground/40")}
          aria-hidden="true"
        >
          ◦
        </span>
      );
  }
}

export function RunningDots(): JSX.Element {
  const { dots } = useStreamTicker(true);
  return (
    <span
      className="min-w-0 flex-1 text-[11px] text-muted-foreground"
      aria-hidden="true"
    >
      {dots}
    </span>
  );
}

export function LiveDuration({
  startedAt,
}: {
  startedAt: number;
}): JSX.Element {
  useStreamTicker(true);
  const elapsed = Date.now() - startedAt;
  return (
    <span
      aria-hidden="true"
      className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground"
    >
      {formatStepDuration(elapsed)}
    </span>
  );
}
