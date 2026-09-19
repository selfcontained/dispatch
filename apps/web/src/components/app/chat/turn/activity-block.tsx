// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit):
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
import { memo, useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, ChevronDown, ChevronRight, Square, X } from "lucide-react";

import { ActivityBars } from "@/components/ui/activity-bars";
import { cn } from "@/lib/utils";

import type { Step, Trace } from "./contracts";
import { formatStepDuration } from "./format";
import { arrive, burstIndex, DURATION, fadeVariants } from "./motion";
import { computeUnaccountedMs } from "./trace";
import { LiveDuration, RunningDots, StatusGlyph, StepRow } from "./step-row";
import { useStreamTicker } from "./use-stream-ticker";
import { useChatRowState } from "../chat-row-state";

/**
 * The rail sits on the post's own background, no fill or frame of its own:
 * a filled block read as a second post inside the post. Steps mask the
 * guide line with the same color.
 */
const BLOCK_FILL = "bg-background";

/**
 * Whether a trace is worth a rail at all: a finished turn that ran no steps
 * has nothing to show, so the block stays unmounted rather than rendering
 * an empty fold.
 */
export function showsActivity(trace: Trace | null | undefined): trace is Trace {
  if (!trace) return false;
  return !(trace.endedAt != null && trace.steps.length === 0);
}

function ActivityBlockImpl({
  trace,
  label,
}: {
  trace: Trace;
  /** Verb for the summary row, derived from the steps; "done" by default. */
  label?: string;
}): JSX.Element {
  const done = trace.endedAt != null;
  const [blockOverride, setBlockOverride] = useChatRowState<boolean | null>(
    "activity-open",
    null
  );
  const [stepOverrides, setStepOverrides] = useChatRowState<
    Record<string, boolean>
  >("activity-steps", {});
  // The rail is open while the turn runs and folds when it settles; a click
  // on the row overrides either way.
  const open = blockOverride ?? !done;
  const reduced = useReducedMotion();

  const unaccountedMs = computeUnaccountedMs(trace);
  // Stream updates must not open and close details underneath the reader.
  const stepOpen = (step: Step): boolean => stepOverrides[step.id] ?? false;
  const toggleStep = (step: Step) =>
    setStepOverrides((prev) => ({ ...prev, [step.id]: !stepOpen(step) }));

  // One container for the whole turn: the summary row is there from the
  // first tick ("thinking") to the last ("ran 2 commands · 4 steps · 9s"),
  // and the rail is a disclosure under it that grows while the turn runs
  // and eases shut when it settles. Nothing swaps out.
  return (
    <div
      className="w-full min-w-0 max-w-full [overflow-wrap:anywhere]"
      data-testid="harness-activity-fold"
    >
      <div
        className="w-full min-w-0 max-w-full"
        data-testid="harness-activity"
        data-open={open ? "true" : "false"}
        data-final-result={trace.finalResult}
      >
        <SummaryRow
          trace={trace}
          label={label}
          open={open}
          onToggle={() => setBlockOverride(!open)}
        />
        <motion.div
          initial={false}
          animate={{ height: open ? "auto" : 0, opacity: open ? 1 : 0 }}
          transition={reduced ? { duration: 0 } : arrive()}
          style={{ overflow: "hidden" }}
          aria-hidden={!open}
        >
          {/* Step rail: a 1px guide line at left:5.5px, with one row per step. */}
          <div className="relative pb-1">
            <span
              aria-hidden="true"
              className="absolute bottom-2 left-[5.5px] top-1 w-px bg-border"
            />
            <div role="list" aria-label="activity steps" className="relative">
              {trace.steps.map((step, i) => (
                <StepRow
                  key={step.id}
                  step={step}
                  index={burstIndex(trace.steps, i)}
                  open={stepOpen(step)}
                  onToggle={() => toggleStep(step)}
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
        </motion.div>
      </div>
    </div>
  );
}

export const ActivityBlock = memo(ActivityBlockImpl);

/**
 * The one row that describes the turn's work at every moment: the glyph
 * says live / done / failed / interrupted, the verb says what is or was
 * being done, the meta counts steps and time, the chevron says whether the
 * rail under it is open. The same node from start to finish, so the eye
 * never has to find the turn again.
 */
function SummaryRow({
  trace,
  label,
  open,
  onToggle,
}: {
  trace: Trace;
  label?: string;
  open: boolean;
  onToggle: () => void;
}): JSX.Element {
  const done = trace.endedAt != null;
  const thinking = !done && trace.steps.length === 0;
  const { dots } = useStreamTicker(!done);
  const failed = trace.finalResult === "error";
  const interrupted = trace.finalResult === "interrupted";
  const verb = done
    ? failed
      ? "failed"
      : interrupted
        ? "interrupted"
        : (label ?? "done")
    : thinking
      ? "thinking"
      : (label ?? "working");
  const stepCount = trace.steps.length;
  const steps = `${stepCount} step${stepCount === 1 ? "" : "s"}`;
  const ms = (trace.endedAt ?? Date.now()) - trace.startedAt;
  const glyph = !done ? (
    // Dispatch's own loading bars, at glyph size.
    <ActivityBars size={11} className="justify-center" />
  ) : failed ? (
    <X className="h-3 w-3 text-status-blocked" strokeWidth={2.5} />
  ) : interrupted ? (
    <Square className="h-2.5 w-2.5 fill-current text-status-waiting" />
  ) : (
    <Check className="h-3 w-3 text-status-done" strokeWidth={2.5} />
  );
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`${verb}, ${steps}, ${formatStepDuration(ms)}, ${open ? "collapse" : "expand"} activity`}
      data-testid="harness-activity-summary"
      data-final-result={trace.finalResult}
      className={cn(
        "flex w-full items-center gap-2 rounded-md py-1 pl-0 pr-1 text-left",
        "hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-status-working/50"
      )}
    >
      <span
        className="flex w-3 shrink-0 justify-center text-[12px] leading-none"
        aria-hidden="true"
      >
        {glyph}
      </span>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={verb}
          variants={fadeVariants}
          initial="hidden"
          animate="shown"
          exit="hidden"
          transition={arrive(DURATION.fast)}
          className={cn(
            "min-w-0 max-w-[60%] truncate text-[12px]",
            done ? "text-foreground" : "font-medium text-status-working"
          )}
          title={verb}
        >
          {verb}
        </motion.span>
      </AnimatePresence>
      {thinking ? (
        <span className="text-[12px] text-muted-foreground" aria-hidden="true">
          {dots}
        </span>
      ) : (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {steps} · {formatStepDuration(ms)}
        </span>
      )}
      {thinking ? (
        <span className="ml-auto text-[10.5px] tabular-nums text-muted-foreground">
          {formatStepDuration(ms)}
        </span>
      ) : null}
      <span
        aria-hidden="true"
        className={cn(
          "text-[9px] text-muted-foreground/70",
          !thinking && "ml-auto"
        )}
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
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
        <ChevronRight className="h-3 w-3" />
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
