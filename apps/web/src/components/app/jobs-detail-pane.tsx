import {
  History,
  MessageSquareText,
  Play,
  Settings,
  Terminal,
} from "lucide-react";
import { useState } from "react";

import { type Agent } from "@/components/app/types";
import { type DetailTab, useJobsContext } from "@/components/app/jobs-context";
import { HistoryTab } from "@/components/app/jobs-history-tab";
import { JobsOverview } from "@/components/app/jobs-overview";
import { PromptTab } from "@/components/app/jobs-prompt-tab";
import { SettingsTab } from "@/components/app/jobs-settings-tab";
import {
  ACTIVE_RUN_STATUSES,
  formatJobDateTime,
  statusClasses,
  statusIcon,
} from "@/components/app/jobs-helpers";
import { errorMessage } from "@/lib/errors";
import { shortPath } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { type AddJobConfig, type Job, type JobRun } from "@/hooks/use-jobs";
import { type AgentType } from "@/lib/agent-types";
import { cn } from "@/lib/utils";

/** Job detail pane for the main content area. */
export function JobDetailPane(): JSX.Element {
  const {
    jobs,
    selectedJob,
    tab,
    history,
    attachedAgent,
    jobStats,
    routeRunId,
    navigate,
    onOpenAgent,
    enabledAgentTypes,
    runNow,
    setEnabled,
    updateJob,
    removeJob,
    justAddedJobId,
    setJustAddedJobId,
    selectJob,
  } = useJobsContext();

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="min-h-0 flex-1 overflow-hidden">
        {selectedJob ? (
          <div className="flex h-full min-h-0 flex-col">
            <JobDetail
              className="min-h-0 flex-1"
              job={selectedJob}
              tab={tab}
              onTabChange={(nextTab) => {
                navigate(
                  `/automations/jobs/${selectedJob.id}${nextTab === "configure" ? "" : `/${nextTab}`}`
                );
              }}
              history={history.data?.runs ?? []}
              historyLoading={history.isLoading}
              selectedRunId={routeRunId ?? null}
              onSelectRun={(runId) => {
                navigate(
                  runId
                    ? `/automations/jobs/${selectedJob.id}/history/${runId}`
                    : `/automations/jobs/${selectedJob.id}/history`
                );
              }}
              attachedAgent={attachedAgent}
              onOpenAgent={onOpenAgent}
              onRunNow={async (job) => {
                await runNow.mutateAsync(job);
              }}
              onSetEnabled={async (job, enabled) => {
                await setEnabled.mutateAsync({ job, enabled });
              }}
              enabledAgentTypes={enabledAgentTypes}
              onUpdateJob={async (job) => {
                await updateJob.mutateAsync(job);
              }}
              onRemoveJob={async (job) => {
                await removeJob.mutateAsync(job);
                navigate("/automations/jobs");
              }}
              isUpdating={updateJob.isPending}
              isRemoving={removeJob.isPending}
              justAdded={justAddedJobId === selectedJob.id}
              onDismissAdded={() => setJustAddedJobId(null)}
            />
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            <JobsOverview
              jobs={jobs}
              stats={jobStats.data ?? null}
              statsLoading={jobStats.isLoading}
              onSelectJob={selectJob}
              onSelectRun={(jobId, runId) =>
                navigate(`/automations/jobs/${jobId}/history/${runId}`)
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}

function JobDetail({
  className,
  job,
  tab,
  onTabChange,
  history,
  historyLoading,
  attachedAgent,
  onOpenAgent,
  onRunNow,
  onSetEnabled,
  enabledAgentTypes,
  onUpdateJob,
  onRemoveJob,
  isUpdating,
  isRemoving,
  justAdded,
  onDismissAdded,
  selectedRunId,
  onSelectRun,
}: {
  className?: string;
  job: Job;
  tab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  history: JobRun[];
  historyLoading: boolean;
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  attachedAgent: { agent: Agent; isActive: boolean } | null;
  onOpenAgent: (agent: Agent) => Promise<void>;
  onRunNow: (job: Job) => Promise<void>;
  onSetEnabled: (job: Job, enabled: boolean) => Promise<void>;
  enabledAgentTypes: AgentType[];
  onUpdateJob: (job: AddJobConfig) => Promise<void>;
  onRemoveJob: (job: Job) => Promise<void>;
  isUpdating: boolean;
  isRemoving: boolean;
  justAdded: boolean;
  onDismissAdded: () => void;
}) {
  const [detailActionError, setDetailActionError] = useState<string | null>(
    null
  );
  const runBlockedReason = job.continuationPending
    ? "The loop is preparing its next run."
    : job.continuationEnabled &&
        job.lastRunStatus &&
        ACTIVE_RUN_STATUSES.includes(job.lastRunStatus)
      ? "This job already has a run in progress."
      : null;
  return (
    <div className={cn("flex h-full min-h-0 flex-col p-4 md:p-6", className)}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-semibold">{job.name}</h2>
          <div
            className="mt-1 truncate font-mono text-xs text-muted-foreground"
            title={job.directory}
          >
            {shortPath(job.directory)}
          </div>
        </div>
        <Button
          size="sm"
          variant="primary"
          disabled={isUpdating || Boolean(runBlockedReason)}
          aria-describedby={
            runBlockedReason ? "job-run-blocked-reason" : undefined
          }
          onClick={() => {
            setDetailActionError(null);
            void onRunNow(job).catch((error) =>
              setDetailActionError(errorMessage(error))
            );
          }}
        >
          <Play className="mr-2 h-4 w-4" />
          Run now
        </Button>
      </div>

      {runBlockedReason ? (
        <p
          id="job-run-blocked-reason"
          role="status"
          className="mt-2 text-right text-xs text-muted-foreground"
        >
          {runBlockedReason}
        </p>
      ) : null}

      {detailActionError ? (
        <div className="mt-2 rounded border border-status-blocked/30 bg-status-blocked/10 p-2 text-sm text-status-blocked">
          {detailActionError}
        </div>
      ) : null}

      {job.continuationEnabled ? (
        <div className="mt-4 rounded-md border border-border/70 bg-muted/20 p-3 text-sm">
          <div className="font-medium text-foreground">
            Loop{" "}
            {job.lastRunIteration ? `• run ${job.lastRunIteration}` : "enabled"}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {job.continuationPending
              ? "Preparing the next run."
              : job.maxIterations === null
                ? "No run limit."
                : `Up to ${job.maxIterations} runs.`}
          </div>
        </div>
      ) : null}

      {attachedAgent ? (
        <div
          className={cn(
            "mt-4 rounded-md border p-3",
            attachedAgent.isActive
              ? "border-status-working/40 bg-status-working/10"
              : "border-border/70 bg-muted/30"
          )}
        >
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <div
                className={cn(
                  "text-sm font-medium",
                  attachedAgent.isActive
                    ? "text-status-working"
                    : "text-foreground"
                )}
              >
                {attachedAgent.isActive
                  ? "Active run is attached to a live agent session."
                  : "Agent kept after completion — pick up where the run left off."}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {attachedAgent.agent.name}
              </div>
            </div>
            <Button
              size="sm"
              onClick={() => void onOpenAgent(attachedAgent.agent)}
            >
              <Terminal className="mr-2 h-4 w-4" />
              Open session
            </Button>
          </div>
        </div>
      ) : null}

      {justAdded ? (
        <div className="mt-4 rounded-md border border-status-done/40 bg-status-done/10 p-4">
          <div className="text-sm font-semibold text-status-done">
            Job added
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
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
              onClick={() => {
                setDetailActionError(null);
                void onRunNow(job).catch((error) =>
                  setDetailActionError(errorMessage(error))
                );
              }}
            >
              <Play className="mr-2 h-4 w-4" />
              Run now
            </Button>
            {!job.enabled ? (
              <Button
                size="sm"
                variant="default"
                disabled={!job.schedule && !job.continuationEnabled}
                onClick={() => {
                  setDetailActionError(null);
                  void onSetEnabled(job, true).catch((error) =>
                    setDetailActionError(errorMessage(error))
                  );
                }}
              >
                {job.continuationEnabled ? "Enable job" : "Enable schedule"}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="default"
              onClick={() => {
                onDismissAdded();
                onTabChange("configure");
              }}
            >
              Edit settings
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onDismissAdded();
                onTabChange("history");
              }}
            >
              View history
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-2 border-b border-border">
        <TabButton
          active={tab === "configure"}
          onClick={() => onTabChange("configure")}
          icon={<Settings className="h-4 w-4" />}
        >
          Configure
        </TabButton>
        <TabButton
          active={tab === "prompt"}
          onClick={() => onTabChange("prompt")}
          icon={<MessageSquareText className="h-4 w-4" />}
        >
          Prompt
        </TabButton>
        <TabButton
          active={tab === "history"}
          onClick={() => onTabChange("history")}
          icon={<History className="h-4 w-4" />}
        >
          History
        </TabButton>
        <Badge
          className={cn("mb-2 self-center", statusClasses(job.lastRunStatus))}
        >
          <span className="mr-1">{statusIcon(job.lastRunStatus)}</span>
          {job.lastRunStatus ?? "never run"}
        </Badge>
      </div>

      {tab === "history" ? (
        <div className="min-h-0 flex-1">
          <HistoryTab
            runs={history}
            loading={historyLoading}
            selectedRunId={selectedRunId}
            onSelectRun={onSelectRun}
          />
        </div>
      ) : tab === "configure" ? (
        <ScrollArea className="min-h-0 flex-1 pr-1">
          <SettingsTab
            job={job}
            enabledAgentTypes={enabledAgentTypes}
            onUpdateJob={onUpdateJob}
            onRemoveJob={onRemoveJob}
            isUpdating={isUpdating}
            isRemoving={isRemoving}
          />
        </ScrollArea>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <PromptTab
            job={job}
            onUpdateJob={onUpdateJob}
            isUpdating={isUpdating}
          />
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground"
      )}
      onClick={onClick}
    >
      {icon}
      {children}
    </button>
  );
}
