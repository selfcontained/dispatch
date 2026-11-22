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
  JobStatusBadge,
} from "@/components/app/jobs-helpers";
import { shortPath } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type UpdateJobConfig, type Job } from "@/hooks/use-jobs";
import { type AgentType } from "@/lib/agent-types";
import { cn } from "@/lib/utils";
import { Alert } from "@/components/ui/alert";
import { AsyncBoundary, LoadError } from "@/components/ui/async-boundary";
import { toast } from "@/components/ui/toast";

/** Job detail pane for the main content area. */
export function JobDetailPane(): JSX.Element {
  const {
    jobs,
    jobsQuery,
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
      <AsyncBoundary query={jobsQuery} thing="jobs" className="m-3">
        {() => (
          <>
            {!selectedJob && jobs.length > 0 && jobStats.error ? (
              <LoadError
                thing="run history"
                error={jobStats.error}
                onRetry={() => void jobStats.refetch()}
                retrying={jobStats.isFetching}
                className="m-3"
              />
            ) : null}
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
                      toast.success(`Job “${job.name}” started.`);
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
                      toast.success(`Job “${job.name}” removed.`);
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
                    statsLoading={jobStats.isPending && !jobStats.error}
                    onSelectJob={selectJob}
                    onSelectRun={(jobId, runId) =>
                      navigate(`/automations/jobs/${jobId}/history/${runId}`)
                    }
                  />
                </div>
              )}
            </div>
          </>
        )}
      </AsyncBoundary>
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
  const [detailActionError, setDetailActionError] = useState<{
    jobId: string;
    title: string;
    error: unknown;
  }>();
  const runBlockedReason = job.continuationPending
    ? "The loop is preparing its next run."
    : job.continuationEnabled &&
        job.lastRunStatus &&
        ACTIVE_RUN_STATUSES.includes(job.lastRunStatus)
      ? "This job already has a run in progress."
      : null;
  const handleRunNow = () => {
    setDetailActionError(undefined);
    void onRunNow(job).catch((error: unknown) =>
      setDetailActionError({
        jobId: job.id,
        title: "Couldn’t start the job.",
        error,
      })
    );
  };
  const handleEnable = () => {
    setDetailActionError(undefined);
    void onSetEnabled(job, true).catch((error: unknown) =>
      setDetailActionError({
        jobId: job.id,
        title: "Couldn’t enable the job.",
        error,
      })
    );
  };
  return (
    <div className={cn("flex h-full min-h-0 flex-col p-4 md:p-6", className)}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="min-w-0 truncate text-heading-lg">{job.name}</h2>
            <JobStatusBadge status={job.lastRunStatus} />
          </div>
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
          <Play />
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

      {detailActionError?.jobId === job.id ? (
        <Alert
          title={detailActionError.title}
          error={detailActionError.error}
          className="mt-2"
        />
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

      <Tabs
        value={tab}
        onValueChange={(next) => onTabChange(next as DetailTab)}
        className="mt-4 flex min-h-0 flex-1 flex-col"
      >
        <TabsList
          aria-label="Job sections"
          className="shrink-0 border-b border-border"
        >
          <TabsTrigger value="configure">
            <Settings />
            Configure
          </TabsTrigger>
          <TabsTrigger value="prompt">
            <MessageSquareText />
            Prompt
          </TabsTrigger>
          <TabsTrigger value="history">
            <History />
            History
          </TabsTrigger>
        </TabsList>
        <TabsContent value={tab} className="flex min-h-0 flex-1 flex-col">
          {tab === "history" ? (
            <div className="min-h-0 flex-1">
              <HistoryTab
                query={history}
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
        </TabsContent>
      </Tabs>
    </div>
  );
}
