import { History, MessageSquareText, Play, Settings } from "lucide-react";
import { useState } from "react";

import { type Agent } from "@/components/app/types";
import { type DetailTab, useJobsContext } from "@/components/app/jobs-context";
import {
  AttachedAgentBanner,
  JobAddedBanner,
} from "@/components/app/jobs-detail-banners";
import { HistoryTab } from "@/components/app/jobs-history-tab";
import { JobsOverview } from "@/components/app/jobs-overview";
import { PromptTab } from "@/components/app/jobs-prompt-tab";
import { SettingsTab } from "@/components/app/jobs-settings-tab";
import {
  ACTIVE_RUN_STATUSES,
  statusClasses,
  statusIcon,
} from "@/components/app/jobs-helpers";
import { LoadError } from "@/components/app/load-error";
import { ActivityBars } from "@/components/ui/activity-bars";
import { statusLabel } from "@/lib/status-label";
import { errorMessage } from "@/lib/errors";
import { shortPath } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { type UpdateJobConfig, type Job } from "@/hooks/use-jobs";
import { type AgentType } from "@/lib/agent-types";
import { cn } from "@/lib/utils";

/** Job detail pane for the main content area. */
export function JobDetailPane(): JSX.Element {
  const {
    jobs,
    isLoading,
    error,
    retry,
    isRetrying,
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
      {error ? (
        <LoadError
          message="Couldn't load jobs"
          error={error}
          onRetry={retry}
          retrying={isRetrying}
          className="m-3"
        />
      ) : !selectedJob && jobs.length > 0 && jobStats.error ? (
        <LoadError
          message="Couldn't load run history"
          error={jobStats.error}
          onRetry={() => void jobStats.refetch()}
          retrying={jobStats.isFetching}
          className="m-3"
        />
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        {isLoading ? (
          <div className="flex h-full items-center justify-center gap-2 text-body-md text-muted-foreground">
            <ActivityBars size={16} /> Loading jobs…
          </div>
        ) : error && jobs.length === 0 ? null : selectedJob ? (
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
              history={history}
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
              statsLoading={jobStats.isPending}
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
  history: ReturnType<typeof useJobsContext>["history"];
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  attachedAgent: { agent: Agent; isActive: boolean } | null;
  onOpenAgent: (agent: Agent) => Promise<void>;
  onRunNow: (job: Job) => Promise<void>;
  onSetEnabled: (job: Job, enabled: boolean) => Promise<void>;
  enabledAgentTypes: AgentType[];
  onUpdateJob: (job: UpdateJobConfig) => Promise<void>;
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
  const handleRunNow = () => {
    setDetailActionError(null);
    void onRunNow(job).catch((error) =>
      setDetailActionError(errorMessage(error))
    );
  };
  const handleEnable = () => {
    setDetailActionError(null);
    void onSetEnabled(job, true).catch((error) =>
      setDetailActionError(errorMessage(error))
    );
  };
  return (
    <div className={cn("flex h-full min-h-0 flex-col p-4 md:p-6", className)}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-heading-lg">{job.name}</h2>
          <div
            className="mt-1 truncate font-mono text-body-sm text-muted-foreground"
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
          onClick={handleRunNow}
        >
          <Play className="mr-2 h-4 w-4" />
          Run now
        </Button>
      </div>

      {runBlockedReason ? (
        <p
          id="job-run-blocked-reason"
          role="status"
          className="mt-2 text-right text-body-sm text-muted-foreground"
        >
          {runBlockedReason}
        </p>
      ) : null}

      {detailActionError ? (
        <div className="mt-2 rounded border border-danger/line bg-danger/tint p-2 text-body-md text-danger">
          {detailActionError}
        </div>
      ) : null}

      {job.continuationEnabled ? (
        <div className="mt-4 rounded-md border border-border-subtle bg-surface-subtle p-3 text-body-md">
          <div className="font-medium text-foreground">
            Loop{" "}
            {job.lastRunIteration ? `• run ${job.lastRunIteration}` : "enabled"}
          </div>
          <div className="mt-1 text-body-sm text-muted-foreground">
            {job.continuationPending
              ? "Preparing the next run."
              : job.maxIterations === null
                ? "No run limit."
                : `Up to ${job.maxIterations} runs.`}
          </div>
        </div>
      ) : null}

      {attachedAgent ? (
        <AttachedAgentBanner
          attachedAgent={attachedAgent}
          onOpenAgent={onOpenAgent}
        />
      ) : null}

      {justAdded ? (
        <JobAddedBanner
          job={job}
          runBlockedReason={runBlockedReason}
          onRunNow={handleRunNow}
          onEnable={handleEnable}
          onEditSettings={() => {
            onDismissAdded();
            onTabChange("configure");
          }}
          onViewHistory={() => {
            onDismissAdded();
            onTabChange("history");
          }}
        />
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
          {job.lastRunStatus ? statusLabel(job.lastRunStatus) : "never run"}
        </Badge>
      </div>

      {tab === "history" ? (
        <div className="min-h-0 flex-1">
          <HistoryTab
            runs={history.data?.runs ?? []}
            loading={history.isPending}
            error={history.error}
            retrying={history.isFetching}
            onRetry={() => void history.refetch()}
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
        "flex items-center gap-2 border-b-2 px-3 py-2 text-body-md transition-colors",
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
