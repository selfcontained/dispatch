import { memo } from "react";
import type { ChatStatusEntry } from "@dispatch/shared";
import { AlertTriangle, Check, Rocket } from "lucide-react";

import { ActivityBars } from "@/components/ui/activity-bars";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/** System events that belong to the setup block, in the order they fire. */
const SETUP_PHASES = new Set(["setup", "started", "create"]);

export function isSetupEvent(entry: ChatStatusEntry): boolean {
  return entry.system === true && SETUP_PHASES.has(entry.phase ?? "");
}

type Step = {
  key: string;
  label: string;
  at: string;
  state: "done" | "now" | "failed";
};

/**
 * One row per setup phase Dispatch reported (worktree, local config,
 * dependencies, engine start). Every phase but the newest is done; the
 * newest is done once the session-started mark follows it, live while the
 * agent is still starting, and failed when the create-failure mark follows.
 */
export function setupSteps(rows: readonly ChatStatusEntry[]): {
  steps: Step[];
  outcome: "live" | "ready" | "failed";
  startedAt: string | null;
  endedAt: string | null;
  failure: string | null;
} {
  const phases = rows.filter((row) => row.phase === "setup");
  const started = rows.find((row) => row.phase === "started") ?? null;
  const failed = rows.find((row) => row.phase === "create") ?? null;
  const outcome = failed ? "failed" : started ? "ready" : "live";
  const steps: Step[] = phases.map((row, index) => {
    const last = index === phases.length - 1;
    return {
      key: row.id,
      // "Creating git worktree…" → "Creating git worktree"
      label: row.message.replace(/…$/, "").replace(/\.\.\.$/, ""),
      at: row.at,
      state: !last
        ? "done"
        : outcome === "failed"
          ? "failed"
          : outcome === "ready"
            ? "done"
            : "now",
    };
  });
  return {
    steps,
    outcome,
    startedAt: phases[0]?.at ?? null,
    endedAt: started?.at ?? failed?.at ?? null,
    failure: failed?.message ?? null,
  };
}

function seconds(from: string, to: string): string {
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return "";
  return ms < 1000 ? "<1s" : `${Math.round(ms / 1000)}s`;
}

/**
 * The agent's setup as one stateful block at the top of its stream: each
 * workspace step ticks off as Dispatch reports it, then the block settles
 * to "Ready in 12s" or shows what failed. Replaces a hairline per phase.
 */
export const SetupBlock = memo(function SetupBlock({
  rows,
}: {
  rows: readonly ChatStatusEntry[];
}): JSX.Element {
  const { steps, outcome, startedAt, endedAt, failure } = setupSteps(rows);
  const aside =
    outcome === "ready" && startedAt && endedAt
      ? `Ready in ${seconds(startedAt, endedAt)}`
      : outcome === "ready"
        ? "Ready"
        : outcome === "failed"
          ? "Failed"
          : "Starting";
  return (
    <div className="px-4 py-1.5" data-testid="chat-setup-block">
      <div
        className={cn(
          "max-w-[72ch] overflow-hidden rounded-lg border bg-card",
          outcome === "live" && "border-status-working/50",
          outcome === "failed" && "border-status-blocked/60",
          outcome === "ready" && "border-border"
        )}
        data-outcome={outcome}
        title={startedAt ? formatDateTime(startedAt) : undefined}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 px-3 py-1.5 text-[11.5px] text-muted-foreground">
          <Rocket className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="font-semibold text-foreground">Setup</span>
          <span
            className={cn(
              "ml-auto tabular-nums",
              outcome === "failed" && "text-status-blocked",
              outcome === "live" && "text-status-working"
            )}
            data-testid="chat-setup-aside"
          >
            {aside}
          </span>
        </div>
        <div className="grid gap-1.5 px-3 py-2.5 text-sm">
          {steps.map((step) => (
            <div
              key={step.key}
              className="flex items-center gap-2"
              data-testid="chat-setup-step"
              data-state={step.state}
            >
              <span
                className={cn(
                  "grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[4px] border",
                  step.state === "done" &&
                    "border-status-working bg-status-working text-background",
                  step.state === "now" && "border-status-working/60",
                  step.state === "failed" &&
                    "border-status-blocked text-status-blocked"
                )}
                aria-hidden="true"
              >
                {step.state === "done" ? (
                  <Check className="h-2.5 w-2.5" strokeWidth={3} />
                ) : step.state === "failed" ? (
                  <AlertTriangle className="h-2.5 w-2.5" strokeWidth={3} />
                ) : (
                  <ActivityBars size={8} className="justify-center" />
                )}
              </span>
              <span
                className={cn(
                  step.state === "done" && "text-muted-foreground",
                  step.state === "now" && "font-medium",
                  step.state === "failed" && "text-status-blocked"
                )}
              >
                {step.label}
              </span>
            </div>
          ))}
          {failure ? (
            <div
              className="mt-1 whitespace-pre-wrap break-words border-l-[3px] border-status-blocked/60 pl-3 text-xs text-muted-foreground"
              data-testid="chat-setup-failure"
            >
              {failure}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
});
