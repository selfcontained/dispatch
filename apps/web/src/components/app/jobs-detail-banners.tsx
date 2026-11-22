import { AgentSessionLink } from "./agent-session-link";
import { Play, Terminal } from "lucide-react";

import { type Agent } from "@/components/app/types";
import { formatJobDateTime } from "@/components/app/jobs-helpers";
import { Button } from "@/components/ui/button";
import { type Job } from "@/hooks/use-jobs";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Shown in the job detail header when a run is (or was) attached to a live agent. */
export function AttachedAgentBanner({
  attachedAgent,
  onOpenAgent,
}: {
  attachedAgent: { agent: Agent; isActive: boolean };
  onOpenAgent: (agent: Agent) => Promise<void>;
}) {
  return (
    <Card
      variant="panel"
      tone={attachedAgent.isActive ? "working" : "neutral"}
      className="mb-4 p-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div
            className={cn(
              "text-body-md font-medium",
              attachedAgent.isActive ? "text-status-working" : "text-foreground"
            )}
          >
            {attachedAgent.isActive
              ? "Active run is attached to a live agent session."
              : "Agent kept after completion — pick up where the run left off."}
          </div>
          <div className="truncate text-body-sm text-muted-foreground">
            <AgentSessionLink
              agentId={attachedAgent.agent.id}
              name={attachedAgent.agent.name}
            />
          </div>
        </div>
        <Button size="sm" onClick={() => void onOpenAgent(attachedAgent.agent)}>
          <Terminal />
          Open session
        </Button>
      </div>
    </Card>
  );
}

/** Shown once, right after a job is created, with next steps for it. */
export function JobAddedBanner({
  job,
  runBlockedReason,
  onRunNow,
  onEnable,
  onEditSettings,
  onViewHistory,
}: {
  job: Job;
  runBlockedReason: string | null;
  onRunNow: () => void;
  onEnable: () => void;
  onEditSettings: () => void;
  onViewHistory: () => void;
}) {
  return (
    <Card variant="panel" tone="info" className="mb-4 p-4">
      <div className="text-body-md font-semibold text-info">Job added</div>
      <div className="mt-1 text-body-md text-muted-foreground">
        {job.enabled && job.nextRun
          ? `Scheduled next run: ${formatJobDateTime(job.nextRun)}.`
          : job.schedule
            ? "This job is saved but not enabled on a schedule yet."
            : "This job is on-demand — use Run now to start it."}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={Boolean(runBlockedReason)}
          aria-describedby={
            runBlockedReason ? "job-run-blocked-reason" : undefined
          }
          onClick={onRunNow}
        >
          <Play />
          Run now
        </Button>
        {!job.enabled ? (
          <Button
            size="sm"
            disabled={!job.schedule && !job.continuationEnabled}
            onClick={onEnable}
          >
            {job.continuationEnabled ? "Enable job" : "Enable schedule"}
          </Button>
        ) : null}
        <Button size="sm" onClick={onEditSettings}>
          Edit settings
        </Button>
        <Button size="sm" variant="ghost" onClick={onViewHistory}>
          View history
        </Button>
      </div>
    </Card>
  );
}
