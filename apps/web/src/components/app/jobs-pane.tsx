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
  XCircle,
} from "lucide-react";
import { createContext, useContext, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { type Agent } from "@/components/app/types";
import { AddJobDialog, AddJobFlow } from "@/components/app/jobs-add-dialog";
import { HistoryTab } from "@/components/app/jobs-history-tab";
import { JobsOverview } from "@/components/app/jobs-overview";
import { PromptTab } from "@/components/app/jobs-prompt-tab";
import { SettingsTab } from "@/components/app/jobs-settings-tab";
import {
  ACTIVE_RUN_STATUSES,
  errorMessage,
  formatDate,
  shortPath,
  statusClasses,
} from "@/components/app/jobs-helpers";
import { ActivityBars } from "@/components/ui/activity-bars";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  type AddJobConfig,
  type Job,
  type JobRun,
  useJobActions,
  useJobHistory,
  useJobs,
  useJobStats,
} from "@/hooks/use-jobs";
import { type AgentType } from "@/lib/agent-types";
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
