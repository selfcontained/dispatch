import { ActivityBars } from "@/components/ui/activity-bars";
import { cn } from "@/lib/utils";

import { PlainBlock } from "./code-block";
import type { Step } from "./contracts";
import { useHarnessContext } from "./harness-context";
import { inputRecord, stepDetailData, subagentSessionId } from "./registry";
import { TurnStream } from "./turn-stream";
import { useHarnessSubagent } from "./use-harness-subagent";
import { toPromptKitTurns } from "./use-harness-turns";

/**
 * Under a `subagent` step: what the parent asked, then the child's own
 * turns nested one level deeper, live while it runs.
 */
export function SubagentDetail({ step }: { step: Step }): JSX.Element {
  const d = stepDetailData(step);
  const input = inputRecord(d.input);
  const prompt = typeof input?.prompt === "string" ? input.prompt : null;
  const sessionId = subagentSessionId(step);
  return (
    <div className="space-y-2.5" data-testid="harness-subagent-detail">
      {prompt ? <PlainBlock text={prompt} /> : null}
      {sessionId ? (
        <SubagentStream sessionId={sessionId} />
      ) : d.terminalOutput ? (
        <PlainBlock text={d.terminalOutput} />
      ) : null}
    </div>
  );
}

function SubagentStream({ sessionId }: { sessionId: string }): JSX.Element {
  const { agentId, live } = useHarnessContext();
  const { subagent, loading, error } = useHarnessSubagent(
    agentId,
    sessionId,
    live
  );
  if (error) {
    return (
      <p
        className="text-[11px] text-muted-foreground"
        data-testid="harness-subagent-error"
      >
        Subagent log unavailable: {error.message}
      </p>
    );
  }
  if (!subagent) {
    return (
      <p className="text-[11px] text-muted-foreground">
        {loading ? "Loading the subagent…" : "No subagent log yet."}
      </p>
    );
  }
  const mapped = toPromptKitTurns(subagent.turns, agentId ?? "");
  // A child still "running" after its parent's turn ended did not finish
  // cleanly; say so instead of spinning for ever.
  const running = subagent.status !== "finished" && live;
  const state =
    subagent.status === "finished"
      ? "finished"
      : !live
        ? "ended"
        : subagent.status === "starting"
          ? "starting"
          : "running";
  return (
    <div
      className="rounded-md border border-border/60 bg-background/60 px-3 py-2"
      data-testid="harness-subagent"
      data-status={state}
    >
      <div className="mb-1 flex items-center gap-2 text-[11px]">
        {running ? (
          <ActivityBars size={10} className="shrink-0" />
        ) : (
          <span
            className={cn(
              "font-bold",
              state === "ended" ? "text-status-waiting" : "text-status-done"
            )}
            aria-hidden="true"
          >
            {state === "ended" ? "■" : "✓"}
          </span>
        )}
        <span
          className={cn(
            "font-medium",
            running ? "text-status-working" : "text-foreground"
          )}
        >
          {subagent.label ?? "subagent"}
        </span>
        {subagent.model ? (
          <span className="truncate text-muted-foreground">
            {subagent.model}
          </span>
        ) : null}
        <span className="ml-auto text-[10.5px] text-muted-foreground">
          {state}
        </span>
      </div>
      <TurnStream
        nested
        turns={mapped.turns}
        liveTrace={mapped.liveTrace}
        liveText={mapped.liveText}
        streaming={mapped.streaming && live}
        ariaLabel={`Subagent ${subagent.label ?? sessionId}`}
        emptyState={
          <p className="text-[11px] text-muted-foreground">
            Waiting for the subagent&apos;s first step…
          </p>
        }
      />
    </div>
  );
}
