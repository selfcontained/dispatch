import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  Activity,
  AlarmClock,
  CheckCircle2,
  Clock,
  History,
  MessageSquareText,
  Play,
  Settings,
  Terminal,
  Trash2,
  XCircle,
} from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { type Agent } from "@/components/app/types";
import { AddJobDialog, AddJobFlow } from "@/components/app/jobs-add-dialog";
import {
  DailyRunsChart,
  JobAvgDuration,
  RunHistoryGrid,
} from "@/components/app/jobs-charts";
import {
  JobFullAccessOption,
  JobKeepAgentOption,
  JobWorktreeOption,
  SwitchToggle,
  WebhookUrl,
} from "@/components/app/jobs-form-fields";
import {
  ACTIVE_RUN_STATUSES,
  cronError,
  errorMessage,
  formatDate,
  formatDuration,
  formatTimeUntil,
  formatTimeUntilDate,
  humanSchedule,
  minutesFromMs,
  msFromMinutes,
  shortPath,
  statusClasses,
  statusDotColor,
  statusTextColor,
  triggerSourceLabel,
} from "@/components/app/jobs-helpers";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type AddJobConfig,
  type Job,
  type JobRun,
  useJobActions,
  useJobHistory,
  useJobs,
  useJobStats,
} from "@/hooks/use-jobs";
import { StatCard } from "@/components/app/stat-card";
import { formatRelativeTime } from "@/lib/format";
import {
  AGENT_TYPE_LABELS,
  type AgentType,
  type CliAgentType,
  isCliAgentType,
} from "@/lib/agent-types";
import { cn } from "@/lib/utils";

type JobsPaneProps = {
  open: boolean;
  agents: Agent[];
  onOpenAgent: (agent: Agent) => Promise<void>;
  enabledAgentTypes: AgentType[];
};

type JobsContextValue = {
  jobs: Job[];
  isLoading: boolean;
  error: unknown;
  selectedJob: Job | null;
  showOverview: boolean;
  showDetailPane: boolean;
  tab: DetailTab;
  history: { data?: { runs: JobRun[] }; isLoading: boolean };
  attachedAgent: { agent: Agent; isActive: boolean } | null;
  jobStats: {
    data?: import("@/hooks/use-jobs").JobStats | null;
    isLoading: boolean;
  };
  routeRunId: string | undefined;
  selectJob: (job: Job) => void;
  openAddJob: () => void;
  actionErrorByJobId: Record<string, string>;
  navigate: ReturnType<typeof useNavigate>;
  agents: Agent[];
  onOpenAgent: (agent: Agent) => Promise<void>;
  enabledAgentTypes: AgentType[];
  addJob: ReturnType<typeof useJobActions>["addJob"];
  runNow: ReturnType<typeof useJobActions>["runNow"];
  setEnabled: ReturnType<typeof useJobActions>["setEnabled"];
  updateJob: ReturnType<typeof useJobActions>["updateJob"];
  removeJob: ReturnType<typeof useJobActions>["removeJob"];
  isAddingJob: boolean;
  setIsAddingJob: (open: boolean) => void;
  justAddedJobId: string | null;
  setJustAddedJobId: (id: string | null) => void;
};

const JobsContext = createContext<JobsContextValue | null>(null);

function useJobsContext(): JobsContextValue {
  const ctx = useContext(JobsContext);
  if (!ctx) throw new Error("useJobsContext must be used within JobsProvider");
  return ctx;
}

type DetailTab = "configure" | "prompt" | "history";

function statusIcon(
  status: import("@/hooks/use-jobs").JobRunStatus | null
): JSX.Element | null {
  if (status === "completed") return <CheckCircle2 className="h-3.5 w-3.5" />;
  if (status === "failed" || status === "timed_out" || status === "crashed")
    return <XCircle className="h-3.5 w-3.5" />;
  if (status === "started" || status === "running" || status === "needs_input")
    return <ActivityBars size={14} className="shrink-0" />;
  return null;
}

function useAttachedJobAgent(job: Job | null, agents: Agent[]) {
  return useMemo(() => {
    if (!job?.lastRunId || !job.lastRunStatus) return null;
    const isActive = ACTIVE_RUN_STATUSES.includes(job.lastRunStatus);
    const keepsAgent = !job.autoArchive;
    if (!isActive && !keepsAgent) return null;
    const match =
      agents.find(
        (agent) =>
          agent.name.startsWith(`job-${job.name}-`) ||
          agent.name.endsWith(job.lastRunId!.slice(0, 8))
      ) ?? null;
    return match ? { agent: match, isActive } : null;
  }, [agents, job]);
}

/** Provider that manages all job state. Wrap around both JobListContent and JobDetailPane. */
export function JobsProvider({
  open,
  agents,
  onOpenAgent,
  enabledAgentTypes,
  children,
}: JobsPaneProps & { children: React.ReactNode }): JSX.Element {
  const navigate = useNavigate();
  const {
    jobId: routeJobId,
    section: routeSection,
    runId: routeRunId,
  } = useParams();
  const { data: jobs = [], isLoading, error } = useJobs(open);
  const { addJob, runNow, setEnabled, updateJob, removeJob } = useJobActions();
  const [isAddingJob, setIsAddingJob] = useState(false);
  const [actionErrorByJobId] = useState<Record<string, string>>({});
  const [justAddedJobId, setJustAddedJobId] = useState<string | null>(null);
  const showOverview = routeJobId === "overview";
  const selectedJob = showOverview
    ? null
    : (jobs.find((job) => job.id === routeJobId) ?? null);
  const tab: DetailTab =
    routeSection === "prompt" || routeSection === "history"
      ? routeSection
      : "configure";
  const history = useJobHistory(selectedJob);
  const attachedAgent = useAttachedJobAgent(selectedJob, agents);
  const jobStats = useJobStats(open && !selectedJob);

  const selectJob = (job: Job) => {
    setIsAddingJob(false);
    setJustAddedJobId(null);
    navigate(`/automations/jobs/${job.id}`);
  };

  const openAddJob = () => {
    setIsAddingJob(true);
    setJustAddedJobId(null);
  };

  const showDetailPane = !!selectedJob || showOverview;

  const ctx: JobsContextValue = {
    jobs,
    isLoading,
    error,
    selectedJob,
    showOverview,
    showDetailPane,
    tab,
    history,
    attachedAgent,
    jobStats,
    routeRunId,
    selectJob,
    openAddJob,
    actionErrorByJobId,
    navigate,
    agents,
    onOpenAgent,
    enabledAgentTypes,
    addJob,
    runNow,
    setEnabled,
    updateJob,
    removeJob,
    isAddingJob,
    setIsAddingJob,
    justAddedJobId,
    setJustAddedJobId,
  };

  return (
    <JobsContext.Provider value={ctx}>
      {children}
      <AddJobDialog open={isAddingJob} onOpenChange={setIsAddingJob}>
        <AddJobFlow
          onAddJob={async (job) => {
            const added = await addJob.mutateAsync(job);
            setIsAddingJob(false);
            setJustAddedJobId(added.id);
            navigate(`/automations/jobs/${added.id}`);
          }}
          isAdding={addJob.isPending}
          enabledAgentTypes={enabledAgentTypes}
        />
      </AddJobDialog>
    </JobsContext.Provider>
  );
}

/** Job list content for the unified sidebar. */
export function JobListContent({
  onItemSelect,
  hideHeader,
}: {
  onItemSelect?: () => void;
  hideHeader?: boolean;
}): JSX.Element {
  const {
    jobs,
    isLoading,
    error,
    selectedJob,
    showOverview,
    actionErrorByJobId,
    selectJob,
    openAddJob,
    navigate,
  } = useJobsContext();

  return (
    <div data-testid="jobs-sidebar" className="flex min-h-0 flex-1 flex-col">
      {hideHeader ? (
        <div className="flex items-center justify-end px-3 py-2">
          <Button
            size="sm"
            variant="default"
            className="bg-muted/35 text-muted-foreground hover:bg-muted/65 hover:text-foreground"
            onClick={openAddJob}
            data-testid="add-job-button"
          >
            <AlarmClock className="mr-1 h-4 w-4" />
            Create
          </Button>
        </div>
      ) : (
        <div className="mt-2 flex h-14 items-center border-b border-border px-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Jobs
          </h2>
          <div className="ml-auto flex items-center">
            <Button
              size="sm"
              variant="default"
              className="bg-muted/35 text-muted-foreground hover:bg-muted/65 hover:text-foreground"
              onClick={openAddJob}
              data-testid="add-job-button"
            >
              <AlarmClock className="mr-1 h-4 w-4" />
              Create
            </Button>
          </div>
        </div>
      )}

      <div
        data-testid="jobs-sidebar-scroll"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {error ? (
          <div className="m-3 rounded-md border border-status-blocked/40 bg-status-blocked/10 p-3 text-sm text-status-blocked">
            {error instanceof Error ? error.message : "Failed to load jobs."}
          </div>
        ) : isLoading ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <ActivityBars size={16} /> Loading jobs...
          </div>
        ) : jobs.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">
            <div className="rounded-md border border-dashed border-border p-4">
              <div className="font-medium text-foreground">
                No jobs added yet.
              </div>
              <div className="mt-1 text-xs">
                Added jobs will appear here — run them on a schedule or on
                demand.
              </div>
            </div>
          </div>
        ) : (
          <div>
            <button
              className={cn(
                "flex w-full items-center gap-2 border-b border-r-4 border-border border-r-transparent px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/40",
                showOverview && "border-r-primary bg-muted/60"
              )}
              onClick={() => {
                navigate("/automations/jobs/overview");
                onItemSelect?.();
              }}
            >
              <Activity className="h-3.5 w-3.5" />
              <span>Overview</span>
            </button>
            {jobs.map((job) => {
              const actionError = actionErrorByJobId[job.id];
              return (
                <div
                  key={job.id}
                  data-testid={`job-row-${job.id}`}
                  className={cn(
                    "w-full cursor-pointer border-b border-r-4 border-border border-r-transparent px-3 py-2 text-left transition-colors hover:bg-muted/40",
                    selectedJob?.id === job.id &&
                      "md:border-r-primary md:bg-muted/60"
                  )}
                  onClick={() => {
                    selectJob(job);
                    onItemSelect?.();
                  }}
                >
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold leading-5">
                        {job.name}
                      </div>
                      <div
                        className="truncate font-mono text-[11px] text-muted-foreground"
                        title={job.directory}
                      >
                        {shortPath(job.directory)}
                      </div>
                    </div>
                    <Badge className={statusClasses(job.lastRunStatus)}>
                      <span className="mr-1 hidden sm:inline-flex">
                        {statusIcon(job.lastRunStatus)}
                      </span>
                      {job.lastRunStatus ?? "new"}
                    </Badge>
                  </div>
                  <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">
                      {job.schedule ? `Cron: ${job.schedule}` : "On demand"}
                    </span>
                    {job.schedule ? (
                      <>
                        <span className="shrink-0 text-muted-foreground/70">
                          •
                        </span>
                        <span className="shrink-0">
                          {job.enabled ? "enabled" : "disabled"}
                        </span>
                      </>
                    ) : null}
                    {!job.autoArchive ? (
                      <>
                        <span className="shrink-0 text-muted-foreground/70">
                          •
                        </span>
                        <span className="shrink-0">keeps agent</span>
                      </>
                    ) : null}
                    {job.callable ? (
                      <>
                        <span className="shrink-0 text-muted-foreground/70">
                          •
                        </span>
                        <span className="shrink-0">callable</span>
                      </>
                    ) : null}
                  </div>
                  {actionError ? (
                    <div className="mt-2 rounded border border-status-blocked/30 bg-status-blocked/10 px-2 py-1 text-xs text-status-blocked">
                      {actionError}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

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

function JobsOverview({
  jobs,
  stats,
  statsLoading,
  onSelectJob,
  onSelectRun,
}: {
  jobs: Job[];
  stats: import("@/hooks/use-jobs").JobStats | null;
  statsLoading: boolean;
  onSelectJob: (job: Job) => void;
  onSelectRun: (jobId: string, runId: string) => void;
}) {
  const upcomingJobs = useMemo(() => {
    return jobs
      .filter((j) => j.nextRun)
      .sort(
        (a, b) =>
          new Date(a.nextRun!).getTime() - new Date(b.nextRun!).getTime()
      )
      .slice(0, 5);
  }, [jobs]);

  const recentRuns = stats?.recentRuns ?? [];
  const metrics = stats?.stats ?? null;
  const hasAnyData = jobs.length > 0;

  const successRate =
    metrics && metrics.totalRuns > 0
      ? Math.round((metrics.successCount / metrics.totalRuns) * 100)
      : null;

  const dailyChartData = useMemo(() => {
    if (!metrics?.daily?.length) return [];
    const byDay = new Map(metrics.daily.map((d) => [d.day, d]));
    const days: Array<{
      day: string;
      label: string;
      completed: number;
      failed: number;
    }> = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const entry = byDay.get(key);
      days.push({
        day: key,
        label: d.toLocaleDateString(undefined, { weekday: "short" }),
        completed: entry?.completed ?? 0,
        failed: entry?.failed ?? 0,
      });
    }
    return days;
  }, [metrics?.daily]);

  if (!hasAnyData) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-muted-foreground">
        <div>
          <AlarmClock className="mx-auto mb-3 h-8 w-8" />
          <div className="font-medium text-foreground">No jobs yet</div>
          <div className="mt-1 max-w-sm text-sm">
            Use jobs for recurring maintenance, scheduled checks, and repeatable
            agent workflows — on a schedule or on demand.
          </div>
        </div>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-5xl space-y-6 px-3 pt-4 pb-12 sm:px-5 sm:pt-6 sm:pb-20 md:px-8">
        {/* Loading */}
        {statsLoading && !metrics && (
          <div className="flex items-center justify-center py-12">
            <ActivityBars size={20} />
          </div>
        )}

        {/* Stats + Chart row */}
        {metrics && metrics.totalRuns > 0 && (
          <>
            <div className="flex flex-wrap gap-2 sm:gap-3">
              <StatCard
                label="Total Runs"
                value={metrics.totalRuns}
                sub="Last 7 days"
              />
              <StatCard
                label="Success Rate"
                value={successRate !== null ? `${successRate}%` : "-"}
                sub="Last 7 days"
                variant={
                  successRate !== null && successRate < 80
                    ? "warning"
                    : undefined
                }
              />
              <StatCard
                label="Avg Duration"
                value={
                  metrics.avgDurationMs
                    ? formatDuration(metrics.avgDurationMs)
                    : "-"
                }
                sub="Last 7 days"
              />
              <StatCard
                label="Failures"
                value={metrics.failureCount}
                sub="Last 7 days"
                variant={metrics.failureCount > 0 ? "warning" : undefined}
              />
            </div>
            {/* Charts 3-up row */}
            <div className="flex flex-col gap-4 sm:flex-row [&>*]:sm:flex-1 [&>*]:sm:min-w-0">
              {dailyChartData.length > 0 && (
                <div>
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Daily Runs
                  </h3>
                  <div className="h-[180px] sm:h-[220px] rounded-md border border-border bg-muted/40 p-3">
                    <DailyRunsChart data={dailyChartData} />
                  </div>
                </div>
              )}
              <JobAvgDuration runs={recentRuns} />
              <RunHistoryGrid runs={recentRuns} />
            </div>
          </>
        )}

        {/* Upcoming */}
        {upcomingJobs.length > 0 && (
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              Upcoming
            </div>
            <div className="divide-y divide-border rounded-md border border-border bg-muted/40">
              {upcomingJobs.map((job) => (
                <button
                  key={job.id}
                  className="flex w-full items-center justify-between px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/50"
                  onClick={() => onSelectJob(job)}
                >
                  <span className="font-medium text-foreground">
                    {job.name}
                  </span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{formatTimeUntil(job.nextRun!)}</span>
                    <span className="hidden text-muted-foreground/60 sm:inline">
                      {formatTimeUntilDate(job.nextRun!)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Recent Activity */}
        {recentRuns.length > 0 && (
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <Activity className="h-3.5 w-3.5" />
              Recent Activity
            </div>
            <div className="divide-y divide-border rounded-md border border-border bg-muted/40">
              {recentRuns
                .filter((run) => jobs.some((j) => j.id === run.jobId))
                .slice(0, 8)
                .map((run) => {
                  return (
                    <button
                      key={run.id}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/50"
                      onClick={() => onSelectRun(run.jobId, run.id)}
                    >
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                        {run.jobName}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 text-xs capitalize",
                          statusTextColor(run.status)
                        )}
                      >
                        {run.status}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {formatDuration(run.durationMs)}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground/60">
                        {formatRelativeTime(run.startedAt)}
                      </span>
                    </button>
                  );
                })}
            </div>
          </div>
        )}

        {/* Empty metrics state — jobs exist but no runs yet */}
        {metrics && metrics.totalRuns === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
            <AlarmClock className="mb-3 h-8 w-8" />
            <div className="font-medium text-foreground">Select a job</div>
            <div className="mt-1 max-w-sm text-sm">
              {upcomingJobs.length > 0
                ? "Your scheduled jobs are set up. Run history and metrics will appear here after the first run."
                : "Run a job to start tracking activity and metrics here."}
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
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
          disabled={isUpdating}
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
              ? `Scheduled next run: ${formatDate(job.nextRun)}.`
              : job.schedule
                ? "This job is saved but not enabled on a schedule yet."
                : "This job is on-demand — use Run now to start it."}
          </div>
          {detailActionError ? (
            <div className="mt-3 rounded border border-status-blocked/30 bg-status-blocked/10 p-2 text-sm text-status-blocked">
              {detailActionError}
            </div>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
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
                disabled={!job.schedule}
                onClick={() => {
                  setDetailActionError(null);
                  void onSetEnabled(job, true).catch((error) =>
                    setDetailActionError(errorMessage(error))
                  );
                }}
              >
                Enable schedule
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

function SettingsTab({
  job,
  enabledAgentTypes,
  onUpdateJob,
  onRemoveJob,
  isUpdating,
  isRemoving,
}: {
  job: Job;
  enabledAgentTypes: AgentType[];
  onUpdateJob: (job: AddJobConfig) => Promise<void>;
  onRemoveJob: (job: Job) => Promise<void>;
  isUpdating: boolean;
  isRemoving: boolean;
}) {
  const [displayName, setDisplayName] = useState(job.name);
  const [schedule, setSchedule] = useState(job.schedule ?? "");
  const [timeoutMinutes, setTimeoutMinutes] = useState(
    minutesFromMs(job.timeoutMs)
  );
  const [needsInputTimeoutMinutes, setNeedsInputTimeoutMinutes] = useState(
    minutesFromMs(job.needsInputTimeoutMs)
  );
  const [agentType, setAgentType] = useState<CliAgentType>(job.agentType);
  const [fullAccess, setFullAccess] = useState(job.fullAccess);
  const [useWorktree, setUseWorktree] = useState(job.useWorktree);
  const [baseBranch, setBaseBranch] = useState(job.baseBranch ?? "main");
  const [branchName, setBranchName] = useState(job.branchName ?? "");
  const [keepAgent, setKeepAgent] = useState(!job.autoArchive);
  const [callable, setCallable] = useState(job.callable);
  const [singleton, setSingleton] = useState(job.singleton);
  const [webhookEnabled, setWebhookEnabled] = useState(job.webhookEnabled);
  const [enabled, setEnabled] = useState(job.enabled);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const effectiveEnabled = schedule.trim() ? enabled : false;
  const scheduleError = cronError(schedule, effectiveEnabled);
  const canSave =
    !!displayName.trim() &&
    !scheduleError &&
    !!msFromMinutes(timeoutMinutes) &&
    !!msFromMinutes(needsInputTimeoutMinutes);

  useEffect(() => {
    setDisplayName(job.name);
    setSchedule(job.schedule ?? "");
    setTimeoutMinutes(minutesFromMs(job.timeoutMs));
    setNeedsInputTimeoutMinutes(minutesFromMs(job.needsInputTimeoutMs));
    setAgentType(job.agentType);
    setFullAccess(job.fullAccess);
    setUseWorktree(job.useWorktree);
    setBaseBranch(job.baseBranch ?? "main");
    setBranchName(job.branchName ?? "");
    setKeepAgent(!job.autoArchive);
    setCallable(job.callable);
    setSingleton(job.singleton);
    setWebhookEnabled(job.webhookEnabled);
    setEnabled(job.enabled);
    setSaveError(null);
    setRemoveError(null);
    setRemoveDialogOpen(false);
    setSaved(false);
  }, [job]);

  return (
    <div className="mt-4 grid gap-4">
      <div className="rounded-md border border-white/[0.12] bg-white/[0.04] p-4">
        <div className="text-sm font-medium">Job configuration</div>
        <p className="mt-1 text-xs text-muted-foreground">
          These values are used when the schedule or Run button starts this job.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="space-y-1 md:col-span-2">
            <label
              className="text-sm text-muted-foreground"
              htmlFor={`settings-name-${job.id}`}
            >
              Name
            </label>
            <Input
              id={`settings-name-${job.id}`}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label
              className="text-sm text-muted-foreground"
              htmlFor={`settings-schedule-${job.id}`}
            >
              Cron schedule{" "}
              <span className="text-muted-foreground/70">(optional)</span>
            </label>
            <Input
              id={`settings-schedule-${job.id}`}
              value={schedule}
              onChange={(event) => setSchedule(event.target.value)}
              placeholder="*/30 * * * *"
              className="font-mono text-xs"
            />
            {scheduleError ? (
              <div className="text-xs text-status-blocked">{scheduleError}</div>
            ) : null}
            {!scheduleError && schedule.trim() ? (
              <div className="text-xs text-muted-foreground">
                {humanSchedule(schedule)}
              </div>
            ) : null}
            {!schedule.trim() ? (
              <div className="text-xs text-muted-foreground">
                Leave blank for an on-demand job.
              </div>
            ) : null}
            {schedule.trim() ? (
              <label className="mt-2 flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-sm">
                <span>
                  <span className="block font-medium text-foreground">
                    Enabled
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Run this job on its saved schedule.
                  </span>
                </span>
                <SwitchToggle
                  checked={enabled}
                  onCheckedChange={setEnabled}
                  ariaLabel="Enable job"
                />
              </label>
            ) : null}
          </div>
          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">Agent type</label>
            <Select
              value={agentType}
              onValueChange={(value) => setAgentType(value as CliAgentType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {enabledAgentTypes.filter(isCliAgentType).map((type) => (
                  <SelectItem key={type} value={type}>
                    {AGENT_TYPE_LABELS[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label
              className="text-sm text-muted-foreground"
              htmlFor={`settings-timeout-${job.id}`}
            >
              Run timeout, minutes
            </label>
            <Input
              id={`settings-timeout-${job.id}`}
              value={timeoutMinutes}
              onChange={(event) => setTimeoutMinutes(event.target.value)}
              inputMode="numeric"
            />
          </div>
          <div className="space-y-1">
            <label
              className="text-sm text-muted-foreground"
              htmlFor={`settings-needs-input-${job.id}`}
            >
              Wait for input, minutes
            </label>
            <Input
              id={`settings-needs-input-${job.id}`}
              value={needsInputTimeoutMinutes}
              onChange={(event) =>
                setNeedsInputTimeoutMinutes(event.target.value)
              }
              inputMode="numeric"
            />
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-3">
          <JobWorktreeOption
            checked={useWorktree}
            cwd={job.directory}
            baseBranch={baseBranch}
            branchName={branchName}
            onCheckedChange={setUseWorktree}
            onBaseBranchChange={setBaseBranch}
            onBranchNameChange={setBranchName}
            testIdPrefix={`job-settings-${job.id}`}
          />
          <JobFullAccessOption
            checked={fullAccess}
            onCheckedChange={setFullAccess}
          />
          <JobKeepAgentOption
            checked={keepAgent}
            onCheckedChange={setKeepAgent}
          />
          <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-sm">
            <span>
              <span className="block font-medium text-foreground">
                Show in command palette
              </span>
              <span className="block text-xs text-muted-foreground">
                Launch this job from the {"⌘"}K palette.
              </span>
            </span>
            <SwitchToggle
              checked={callable}
              onCheckedChange={setCallable}
              ariaLabel="Show in command palette"
            />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-sm">
            <span>
              <span className="block font-medium text-foreground">
                Single instance
              </span>
              <span className="block text-xs text-muted-foreground">
                Only allow one active run at a time.
              </span>
            </span>
            <SwitchToggle
              checked={singleton}
              onCheckedChange={setSingleton}
              ariaLabel="Single instance"
            />
          </label>
          <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-sm">
            <label className="flex items-center justify-between gap-3">
              <span>
                <span className="block font-medium text-foreground">
                  Webhook trigger
                </span>
                <span className="block text-xs text-muted-foreground">
                  Trigger this job via an HTTP POST to a secret URL.
                </span>
              </span>
              <SwitchToggle
                checked={webhookEnabled}
                onCheckedChange={setWebhookEnabled}
                ariaLabel="Webhook trigger"
              />
            </label>
            {webhookEnabled && job.webhookSecret ? (
              <WebhookUrl secret={job.webhookSecret} />
            ) : webhookEnabled && !job.webhookSecret ? (
              <div className="mt-2 text-xs text-muted-foreground">
                Save to generate a webhook URL.
              </div>
            ) : null}
          </div>
        </div>
        {saveError ? (
          <div className="mt-4 rounded-md border border-status-blocked/40 bg-status-blocked/10 p-3 text-sm text-status-blocked">
            {saveError}
          </div>
        ) : null}
        {saved ? (
          <div className="mt-4 rounded-md border border-status-done/40 bg-status-done/10 p-3 text-sm text-status-done">
            Settings saved.
          </div>
        ) : null}
        <div className="mt-4 flex justify-end">
          <Button
            variant="primary"
            disabled={!canSave || isUpdating}
            onClick={() => {
              setSaveError(null);
              setSaved(false);
              void onUpdateJob({
                name: job.name,
                directory: job.directory,
                displayName,
                schedule: schedule.trim() || null,
                timeoutMs: msFromMinutes(timeoutMinutes),
                needsInputTimeoutMs: msFromMinutes(needsInputTimeoutMinutes),
                agentType,
                useWorktree,
                baseBranch: useWorktree ? baseBranch : null,
                branchName: useWorktree ? branchName : null,
                fullAccess,
                autoArchive: !keepAgent,
                callable,
                singleton,
                webhookEnabled,
                enabled: effectiveEnabled,
              })
                .then(() => {
                  setSaved(true);
                })
                .catch((error) => {
                  setSaveError(errorMessage(error));
                });
            }}
          >
            {isUpdating ? <ActivityBars size={16} className="mr-2" /> : null}
            Save
          </Button>
        </div>
      </div>
      <div className="rounded-md border border-status-blocked/30 bg-status-blocked/5 p-4">
        <div className="text-sm font-medium text-status-blocked">
          Remove job
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Remove this saved job, schedule, and run history from this Dispatch
          instance.
        </p>
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <Button
            variant="destructive"
            size="sm"
            disabled={isRemoving}
            onClick={() => {
              setRemoveError(null);
              setRemoveDialogOpen(true);
            }}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Remove
          </Button>
        </div>
        {removeError ? (
          <div className="mt-3 rounded-md border border-status-blocked/40 bg-status-blocked/10 p-3 text-sm text-status-blocked">
            {removeError}
          </div>
        ) : null}
      </div>
      <RemoveJobDialog
        open={removeDialogOpen}
        job={job}
        isRemoving={isRemoving}
        onOpenChange={setRemoveDialogOpen}
        onConfirm={() => {
          setRemoveError(null);
          void onRemoveJob(job)
            .then(() => setRemoveDialogOpen(false))
            .catch((error) => setRemoveError(errorMessage(error)));
        }}
      />
    </div>
  );
}

function RemoveJobDialog({
  open,
  job,
  isRemoving,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  job: Job;
  isRemoving: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-md" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-white/[0.2] bg-[hsl(var(--card))] backdrop-blur-2xl p-5 shadow-[0_16px_64px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.15)] outline-none">
          <DialogPrimitive.Title className="text-base font-semibold">
            Remove job?
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-2 text-sm text-muted-foreground">
            Remove{" "}
            <span className="font-medium text-foreground">{job.name}</span> from
            this Dispatch instance? This removes its saved schedule and run
            history.
          </DialogPrimitive.Description>
          <div className="mt-5 flex justify-end gap-2">
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" disabled={isRemoving}>
                Cancel
              </Button>
            </DialogPrimitive.Close>
            <Button
              variant="destructive"
              disabled={isRemoving}
              onClick={onConfirm}
            >
              {isRemoving ? (
                <ActivityBars size={16} className="mr-2" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              Remove
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function PromptTab({
  job,
  onUpdateJob,
  isUpdating,
}: {
  job: Job;
  onUpdateJob: (job: AddJobConfig) => Promise<void>;
  isUpdating: boolean;
}) {
  const [prompt, setPrompt] = useState(job.prompt ?? "");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setPrompt(job.prompt ?? "");
    setSaveError(null);
    setSaved(false);
  }, [job]);

  return (
    <div className="mt-4 flex h-full min-h-full flex-col">
      <div className="flex h-full min-h-full flex-1 flex-col rounded-md border border-white/[0.12] bg-white/[0.04] p-4">
        <div className="space-y-1">
          <label
            className="text-sm font-medium text-foreground"
            htmlFor={`prompt-${job.id}`}
          >
            Prompt
          </label>
          <p className="text-xs text-muted-foreground">
            The instructions the agent will follow when this job runs.
          </p>
        </div>
        <textarea
          id={`prompt-${job.id}`}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe what the agent should do..."
          className="mt-2 h-[max(16rem,calc(100dvh-21rem))] min-h-64 shrink-0 w-full rounded-md border border-white/[0.12] bg-white/[0.04] backdrop-blur-md shadow-[inset_0_2px_6px_rgba(0,0,0,0.3)] px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {saveError ? (
          <div className="mt-4 rounded-md border border-status-blocked/40 bg-status-blocked/10 p-3 text-sm text-status-blocked">
            {saveError}
          </div>
        ) : null}
        {saved ? (
          <div className="mt-4 rounded-md border border-status-done/40 bg-status-done/10 p-3 text-sm text-status-done">
            Prompt saved.
          </div>
        ) : null}
        <div className="mt-4 flex justify-end">
          <Button
            variant="primary"
            disabled={isUpdating}
            onClick={() => {
              setSaveError(null);
              setSaved(false);
              void onUpdateJob({
                name: job.name,
                directory: job.directory,
                prompt: prompt.trim() || null,
              })
                .then(() => {
                  setSaved(true);
                })
                .catch((error) => {
                  setSaveError(errorMessage(error));
                });
            }}
          >
            {isUpdating ? <ActivityBars size={16} className="mr-2" /> : null}
            Save prompt
          </Button>
        </div>
      </div>
    </div>
  );
}

function HistoryTab({
  runs,
  loading,
  selectedRunId,
  onSelectRun,
}: {
  runs: JobRun[];
  loading: boolean;
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
}) {
  const selectedRun = selectedRunId
    ? (runs.find((run) => run.id === selectedRunId) ?? null)
    : null;
  return (
    <ScrollArea className="mt-4 min-h-0 h-full pr-1">
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ActivityBars size={16} /> Loading history...
        </div>
      ) : runs.length === 0 ? (
        <div className="text-sm text-muted-foreground">No runs yet.</div>
      ) : (
        <div className="flex flex-col">
          {runs.map((run) => {
            const isSelected = selectedRun?.id === run.id;
            const isActive =
              run.status === "started" ||
              run.status === "running" ||
              run.status === "needs_input";
            return (
              <div key={run.id}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2.5 overflow-hidden py-1.5 text-left text-xs transition-colors hover:text-foreground",
                    isSelected ? "text-foreground" : "text-muted-foreground"
                  )}
                  onClick={() => onSelectRun(isSelected ? "" : run.id)}
                >
                  <span
                    className={cn(
                      "h-2 w-2 shrink-0 rounded-full",
                      statusDotColor(run.status),
                      isActive && "animate-pulse"
                    )}
                  />
                  <span
                    className={cn(
                      "shrink-0 font-medium",
                      statusTextColor(run.status)
                    )}
                  >
                    {run.status}
                  </span>
                  <span className="min-w-0 truncate font-mono tabular-nums">
                    {formatDate(run.startedAt)}
                  </span>
                  <span className="font-mono tabular-nums opacity-50">
                    {formatDuration(run.durationMs)}
                  </span>
                  <span className="opacity-40">{triggerSourceLabel(run)}</span>
                </button>
                {isSelected && <RunReport run={run} />}
              </div>
            );
          })}
        </div>
      )}
    </ScrollArea>
  );
}

function RunReport({ run }: { run: JobRun | null }) {
  if (!run) {
    return (
      <div className="mb-2 ml-4 border-l-2 border-border pl-3 text-xs text-muted-foreground">
        Select a run.
      </div>
    );
  }
  return (
    <div className="mb-2 ml-[3px] border-l-2 border-border pl-4">
      {run.report?.summary && (
        <div className="pb-1 text-xs text-muted-foreground">
          {run.report.summary}
        </div>
      )}
      {run.report?.tasks.map((task, index) => (
        <div key={`${task.name}-${index}`} className="py-0.5">
          <div className="flex items-center gap-1.5 text-xs">
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                task.status === "success"
                  ? "bg-status-done"
                  : task.status === "error"
                    ? "bg-status-blocked"
                    : "bg-muted-foreground"
              )}
            />
            <span className="font-medium">{task.name}</span>
            {task.status === "error" && (
              <span className="uppercase text-status-blocked">
                {task.status}
              </span>
            )}
          </div>
          {task.summary ? (
            <div className="pl-3.5 text-xs text-muted-foreground/70">
              {task.summary}
            </div>
          ) : null}
          {task.errors?.map((error, errorIndex) => (
            <div
              key={errorIndex}
              className="pl-3.5 text-xs text-status-blocked"
            >
              {error.message}
              {error.action ? (
                <span className="ml-2 text-muted-foreground">
                  {error.action}
                </span>
              ) : null}
            </div>
          ))}
          {task.logs?.slice(-5).map((log, logIndex) => (
            <div
              key={logIndex}
              className="pl-3.5 font-mono text-[11px] text-muted-foreground/50"
            >
              [{log.level}] {log.message}
            </div>
          ))}
        </div>
      ))}
      {run.pendingQuestion && (
        <div className="flex items-start gap-1.5 py-1 text-xs">
          <MessageSquareText className="mt-0.5 h-3 w-3 shrink-0 text-status-waiting" />
          <span className="text-status-waiting">{run.pendingQuestion}</span>
        </div>
      )}
      {run.completedAt && (
        <div className="pt-1 font-mono text-[11px] text-muted-foreground/50">
          Completed {formatDate(run.completedAt)}
        </div>
      )}
      {!run.report && !run.pendingQuestion && (
        <div className="text-xs text-muted-foreground">No report yet.</div>
      )}
    </div>
  );
}
