// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit):
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
import { memo, useEffect, useRef, useState, type RefObject } from "react";

import { ActivityBars } from "@/components/ui/activity-bars";
import { cn } from "@/lib/utils";

import type { Step, Trace } from "./contracts";
import { formatStepDuration } from "./format";
import { computeUnaccountedMs } from "./trace";
import { isSubagentStep } from "./registry";
import { LiveDuration, RunningDots, StatusGlyph, StepRow } from "./step-row";
import { useStreamTicker } from "./use-stream-ticker";

/** Fill behind the rail; steps mask the guide line with the same color. */
const BLOCK_FILL = "bg-muted";

function ActivityBlockImpl({
  trace,
  label,
}: {
  trace: Trace;
  /** Verb for the collapsed summary; "done" by default. */
  label?: string;
}): JSX.Element {
  const done = trace.endedAt != null;
  const [blockOverride, setBlockOverride] = useState<boolean | null>(null);
  const [stepOverrides, setStepOverrides] = useState<Record<string, boolean>>(
    {}
  );
  // open = userOverride ?? !done  (open while running; collapsed when done)
  const open = blockOverride ?? !done;
  // Toggling the block swaps its toggle control between the header collapse
  // button and the CollapsedSummary button — two different DOM nodes, so a
  // plain re-render drops focus to <body>. The effect moves focus to the
  // newly-mounted control when a click flipped it.
  const collapseButtonRef = useRef<HTMLButtonElement>(null);
  const summaryButtonRef = useRef<HTMLButtonElement>(null);
  const justToggledRef = useRef(false);
  useEffect(() => {
    if (!justToggledRef.current) return;
    justToggledRef.current = false;
    if (open) collapseButtonRef.current?.focus();
    else summaryButtonRef.current?.focus();
  }, [open]);
  const handleExpand = () => {
    justToggledRef.current = true;
    setBlockOverride(true);
  };
  const handleCollapse = () => {
    justToggledRef.current = true;
    setBlockOverride(false);
  };

  if (done && !open) {
    return (
      <CollapsedSummary
        trace={trace}
        label={label}
        onExpand={handleExpand}
        buttonRef={summaryButtonRef}
      />
    );
  }

  const unaccountedMs = computeUnaccountedMs(trace);
  // Open while running; a subagent step stays open while the turn runs,
  // since its call returns the moment the child starts and the child's
  // progress lives under it.
  const stepOpen = (step: Step): boolean =>
    stepOverrides[step.id] ??
    (!done && (step.status === "running" || isSubagentStep(step)));
  const toggleStep = (id: string) =>
    setStepOverrides((prev) => ({ ...prev, [id]: !(prev[id] ?? false) }));

  return (
    <div
      className={cn(
        "rounded-md border border-border/60 px-3 py-2.5",
        BLOCK_FILL
      )}
      data-testid="harness-activity"
    >
      <BlockHeader
        trace={trace}
        collapsible={done}
        onCollapse={handleCollapse}
        buttonRef={collapseButtonRef}
      />
      {/* Step rail: a 1px guide line at left:5.5px, with one row per step. */}
      <div className="relative mt-1.5">
        <span
          aria-hidden="true"
          className="absolute bottom-1 left-[5.5px] top-1 w-px bg-border"
        />
        <div role="list" aria-label="activity steps" className="relative">
          {trace.steps.map((step) => (
            <StepRow
              key={step.id}
              step={step}
              open={stepOpen(step)}
              onToggle={() => toggleStep(step.id)}
              maskClass={BLOCK_FILL}
            />
          ))}
          {!done &&
          trace.steps.length > 0 &&
          !trace.steps.some((s) => s.status === "running") ? (
            <ThinkingRow
              since={trace.steps.reduce(
                (latest, s) => Math.max(latest, s.endedAt ?? s.startedAt),
                trace.startedAt
              )}
              maskClass={BLOCK_FILL}
            />
          ) : null}
          {unaccountedMs > 0 ? (
            <UnaccountedRow ms={unaccountedMs} maskClass={BLOCK_FILL} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

export const ActivityBlock = memo(ActivityBlockImpl);

function BlockHeader({
  trace,
  collapsible,
  onCollapse,
  buttonRef,
}: {
  trace: Trace;
  collapsible: boolean;
  onCollapse: () => void;
  buttonRef: RefObject<HTMLButtonElement>;
}): JSX.Element {
  const done = trace.endedAt != null;
  const thinking = !done && trace.steps.length === 0;
  const { dots } = useStreamTicker(!done);
  const label = done
    ? trace.finalResult === "error"
      ? "failed"
      : "complete"
    : thinking
      ? "thinking"
      : "working";
  const glyph = !done ? (
    // Dispatch's own loading bars, at glyph size.
    <ActivityBars size={11} className="justify-center" />
  ) : trace.finalResult === "error" ? (
    <span className="font-bold text-status-blocked" aria-hidden="true">
      ✗
    </span>
  ) : (
    <span className="font-bold text-status-done" aria-hidden="true">
      ✓
    </span>
  );
  const inner = (
    <>
      <span className="flex w-3 justify-center text-[12px] leading-none">
        {glyph}
      </span>
      <span
        className={cn(
          "text-[12px]",
          done ? "text-foreground" : "font-medium text-status-working"
        )}
      >
        {label}
      </span>
      {thinking ? (
        <span className="text-[12px] text-muted-foreground" aria-hidden="true">
          {dots}
        </span>
      ) : null}
      <Elapsed trace={trace} />
      {collapsible ? (
        <span
          aria-hidden="true"
          className="text-[9px] text-muted-foreground/70"
        >
          ⏷
        </span>
      ) : null}
    </>
  );
  return collapsible ? (
    <button
      ref={buttonRef}
      type="button"
      onClick={onCollapse}
      aria-label="Collapse activity"
      className="flex w-full items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-status-working/50"
    >
      {inner}
    </button>
  ) : (
    <div className="flex w-full items-center gap-2">{inner}</div>
  );
}

function Elapsed({ trace }: { trace: Trace }): JSX.Element {
  const done = trace.endedAt != null;
  useStreamTicker(!done); // repaint while running
  const ms = (trace.endedAt ?? Date.now()) - trace.startedAt;
  return (
    <span
      aria-hidden="true"
      className="ml-auto text-[10.5px] tabular-nums text-muted-foreground"
    >
      {formatStepDuration(ms)}
    </span>
  );
}

function CollapsedSummary({
  trace,
  label,
  onExpand,
  buttonRef,
}: {
  trace: Trace;
  label?: string;
  onExpand: () => void;
  buttonRef: RefObject<HTMLButtonElement>;
}): JSX.Element {
  const stepCount = trace.steps.length;
  const dur = (trace.endedAt ?? trace.startedAt) - trace.startedAt;
  const failed = trace.finalResult === "error";
  const verb = failed ? "failed" : (label ?? "done");
  const steps = `${stepCount} step${stepCount === 1 ? "" : "s"}`;
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onExpand}
      aria-label={`${verb}, ${steps}, ${formatStepDuration(dur)} — expand activity`}
      data-testid="harness-activity-summary"
      className={cn(
        "animate-harness-row flex w-full items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5 text-left motion-reduce:animate-none",
        "hover:border-border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-status-working/50",
        BLOCK_FILL
      )}
    >
      <span
        className="flex w-3 justify-center text-[12px] leading-none"
        aria-hidden="true"
      >
        {failed ? (
          <span className="font-bold text-status-blocked">✗</span>
        ) : (
          <span className="font-bold text-status-done">✓</span>
        )}
      </span>
      <span
        className="min-w-0 max-w-[60%] truncate text-[12px] text-foreground"
        title={verb}
      >
        {verb}
      </span>
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {steps} · {formatStepDuration(dur)}
      </span>
      <span
        aria-hidden="true"
        className="ml-auto text-[9px] text-muted-foreground/70"
      >
        ⏵
      </span>
    </button>
  );
}

/** How long the rail waits with nothing running before it says "thinking". */
const THINKING_DELAY_MS = 500;

/**
 * The model is between steps: reading a result, reasoning, or composing.
 * Nothing in the stream is open, so without this the rail's last row sits
 * finished and the turn looks stalled. Timed from the last thing that ended.
 */
function ThinkingRow({
  since,
  maskClass,
}: {
  since: number;
  maskClass: string;
}): JSX.Element | null {
  // Back-to-back tool calls leave a few dozen milliseconds between steps;
  // showing the row for those makes the rail flicker. Only a real pause
  // earns it.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setShown(false);
    const timer = setTimeout(() => setShown(true), THINKING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [since]);
  if (!shown) return null;
  return (
    <div
      className="flex items-center gap-[9px] py-1"
      role="listitem"
      aria-label="thinking, running"
      data-testid="harness-thinking-row"
    >
      <StatusGlyph status="running" maskClass={maskClass} />
      <span className="shrink-0 text-[12px] font-medium text-status-working">
        thinking
      </span>
      <RunningDots />
      <LiveDuration startedAt={since} />
      <span aria-hidden="true" className="invisible w-2 shrink-0 text-[9px]">
        ⏵
      </span>
    </div>
  );
}

function UnaccountedRow({
  ms,
  maskClass,
}: {
  ms: number;
  maskClass: string;
}): JSX.Element {
  return (
    <div
      className="flex items-center gap-[9px] py-1 text-[11px]"
      role="listitem"
      aria-label={`Unaccounted time, ${formatStepDuration(ms)}`}
    >
      <span
        className={cn("flex w-3 justify-center text-status-waiting", maskClass)}
        aria-hidden="true"
      >
        !
      </span>
      <span className="flex-1 text-muted-foreground">unaccounted time</span>
      <span className="text-[10.5px] tabular-nums text-muted-foreground">
        {formatStepDuration(ms)}
      </span>
    </div>
  );
}
