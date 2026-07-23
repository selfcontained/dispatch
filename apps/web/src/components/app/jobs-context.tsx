import { createContext, useContext, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { type Agent } from "@/components/app/types";
import { AddJobDialog, AddJobFlow } from "@/components/app/jobs-add-dialog";
import { ACTIVE_RUN_STATUSES } from "@/components/app/jobs-helpers";
import {
  type Job,
  type JobRun,
  type JobStats,
  useJobActions,
  useJobHistory,
  useJobs,
  useJobStats,
} from "@/hooks/use-jobs";
import { type AgentType } from "@/lib/agent-types";

type JobsProviderProps = {
  open: boolean;
  agents: Agent[];
  onOpenAgent: (agent: Agent) => Promise<void>;
  enabledAgentTypes: AgentType[];
};

export type DetailTab = "configure" | "prompt" | "history";

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
    data?: JobStats | null;
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

export function useJobsContext(): JobsContextValue {
  const ctx = useContext(JobsContext);
  if (!ctx) throw new Error("useJobsContext must be used within JobsProvider");
  return ctx;
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
}: JobsProviderProps & { children: React.ReactNode }): JSX.Element {
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
