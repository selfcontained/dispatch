import { memo } from "react";
import type { ChatStatusEntry } from "@dispatch/shared";
import { AlertTriangle } from "lucide-react";

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
 * The agent's setup as one quiet line at the top of its stream: what
 * Dispatch is doing right now while the agent starts, "Started in 12s"
 * once it is up, or what failed. The phases are the line's title.
 */
export const SetupBlock = memo(function SetupBlock({
  rows,
}: {
  rows: readonly ChatStatusEntry[];
}): JSX.Element {
  const { steps, outcome, startedAt, endedAt, failure } = setupSteps(rows);
  const current = steps[steps.length - 1];
  const text =
    outcome === "ready"
      ? startedAt && endedAt
        ? `Started in ${seconds(startedAt, endedAt)}`
        : "Started"
      : outcome === "failed"
        ? "Setup failed"
        : current
          ? `${current.label}…`
          : "Starting…";
  return (
    <div
      className="px-4 py-1"
      data-testid="chat-setup-block"
      data-outcome={outcome}
      title={[
        startedAt ? formatDateTime(startedAt) : null,
        ...steps.map((step) => step.label),
      ]
        .filter(Boolean)
        .join("\n")}
    >
      <div
        className={cn(
          "flex items-center gap-2 pl-11 text-[11px] text-muted-foreground",
          outcome === "failed" && "text-status-blocked"
        )}
      >
        {outcome === "live" ? (
          <span
            aria-hidden="true"
            className="inline-block h-1.5 w-1.5 rounded-full bg-status-working"
          />
        ) : outcome === "failed" ? (
          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
        ) : null}
        <span data-testid="chat-setup-aside">{text}</span>
      </div>
      {failure ? (
        <div
          className="mt-1 whitespace-pre-wrap break-words border-l-[3px] border-status-blocked/60 pl-3 text-xs text-muted-foreground"
          data-testid="chat-setup-failure"
        >
          {failure}
        </div>
      ) : null}
    </div>
  );
});
