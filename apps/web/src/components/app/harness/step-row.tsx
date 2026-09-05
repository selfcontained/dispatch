// Ported from @mytraai/promptkit (MytraAI/mytra-os-uis, packages/promptkit) —
// Nii Yeboah's PromptKit design. Adapted to Dispatch's tokens and shadcn.
import { cn } from "@/lib/utils";

import type { Step, StepStatus } from "./contracts";
import { formatStepDuration } from "./format";
import { kindLabel, stepSummary } from "./registry";
import { StepDetail } from "./step-detail";
import { useStreamTicker } from "./use-stream-ticker";

const STATUS_ARIA: Record<StepStatus, string> = {
  running: "running",
  ok: "completed",
  retry: "retrying",
  error: "failed",
  skipped: "skipped",
};

/** One step in the activity rail: glyph, label, summary, duration, toggle. */
export function StepRow({
  step,
  open,
  onToggle,
  maskClass,
}: {
  step: Step;
  open: boolean;
  onToggle: () => void;
  /** Background class that hides the rail line behind the glyph. */
  maskClass: string;
}): JSX.Element {
  const running = step.status === "running";
  // Done steps show their one-line summary; running steps animate dots instead.
  const summary = running ? undefined : stepSummary(step);
  // An explicit step.label wins over the registry's kind label.
  const label = (step.label || kindLabel(step.kind)).toLowerCase();
  return (
    <div
      className="animate-harness-row motion-reduce:animate-none"
      role="listitem"
      aria-live={running ? "polite" : undefined}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`${label}, ${STATUS_ARIA[step.status]}`}
        className="flex w-full items-center gap-[9px] py-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-status-working/50"
      >
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
          {step.attempt && step.attempt > 0 ? (
            <span className="ml-1 text-muted-foreground">·{step.attempt}</span>
          ) : null}
        </span>
        {running ? (
          <RunningDots />
        ) : summary ? (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            — {summary}
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
          className="shrink-0 text-[9px] text-muted-foreground/70"
        >
          {open ? "⏷" : "⏵"}
        </span>
      </button>
      {/* grid-rows 0fr->1fr height animation */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.2,0.7,0.2,1)] motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="overflow-hidden">
          {open ? <StepDetail step={step} /> : null}
        </div>
      </div>
    </div>
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
        <span
          className={cn(
            base,
            "animate-harness-pop font-bold text-status-done motion-reduce:animate-none"
          )}
          aria-hidden="true"
        >
          ✓
        </span>
      );
    case "retry":
      return (
        <span className={cn(base, "text-status-waiting")} aria-hidden="true">
          ↻
        </span>
      );
    case "error":
      return (
        <span
          className={cn(base, "font-bold text-status-blocked")}
          aria-hidden="true"
        >
          ✗
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

function RunningDots(): JSX.Element {
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

function LiveDuration({ startedAt }: { startedAt: number }): JSX.Element {
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
