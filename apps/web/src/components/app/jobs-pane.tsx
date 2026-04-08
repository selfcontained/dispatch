import * as DialogPrimitive from "@radix-ui/react-dialog";
import cronstrue from "cronstrue";
import { Activity, AlarmClock, ArrowLeft, BookOpenText, Bot, CheckCircle2, ChevronDown, Clock, GitBranch, History, Loader2, LoaderCircle, MessageSquareText, Play, Plus, RefreshCw, Search, Settings, Terminal, Trash2, X, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { PathInput } from "@/components/app/path-input";
import { type Agent } from "@/components/app/types";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { type AddJobConfig, type AvailableJobsDirectory, type Job, type JobRun, type JobRunStatus, useAvailableJobs, useJobActions, useJobHistory, useJobs } from "@/hooks/use-jobs";
import { useIconColor } from "@/hooks/use-icon-color";
import { useInstanceName } from "@/hooks/use-instance-name";
import { AGENT_TYPE_LABELS, type AgentType } from "@/lib/agent-types";
import { cn } from "@/lib/utils";

type JobsPaneProps = {
  open: boolean;
  onClose: () => void;
  agents: Agent[];
  onOpenAgent: (agent: Agent) => Promise<void>;
  enabledAgentTypes: AgentType[];
  footer?: React.ReactNode;
};

type DetailTab = "configure" | "prompt" | "history";
type AddJobStep = "choose" | "configure";
type AddJobSourceTab = "automatic" | "manual";

const ACTIVE_RUN_STATUSES: JobRunStatus[] = ["started", "running", "needs_input"];

function statusClasses(status: JobRunStatus | null): string {
  if (status === "completed") return "border-status-done/45 bg-status-done/15 text-status-done";
  if (status === "failed" || status === "timed_out" || status === "crashed") return "border-status-blocked/45 bg-status-blocked/15 text-status-blocked";
  if (status === "needs_input") return "border-status-waiting/45 bg-status-waiting/15 text-status-waiting";
  if (status === "started" || status === "running") return "border-status-working/45 bg-status-working/15 text-status-working";
  return "border-border bg-muted/35 text-muted-foreground";
}

function statusIcon(status: JobRunStatus | null): JSX.Element | null {
  if (status === "completed") return <CheckCircle2 className="h-3.5 w-3.5" />;
  if (status === "failed" || status === "timed_out" || status === "crashed") return <XCircle className="h-3.5 w-3.5" />;
  if (status === "started" || status === "running" || status === "needs_input") return <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" />;
  return null;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "Not scheduled";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatDuration(ms: number | null | undefined): string {
  if (!ms) return "n/a";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

function minutesFromMs(ms: number | null | undefined): string {
  if (!ms) return "";
  return String(Math.max(1, Math.round(ms / 60_000)));
}

function msFromMinutes(value: string): number | undefined {
  const minutes = Number.parseInt(value, 10);
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined;
  return minutes * 60_000;
}

function fileStemFromPath(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const fileName = filePath.split("/").pop();
  return fileName?.endsWith(".md") ? fileName.slice(0, -3) : fileName ?? null;
}

function jobFileStem(job: Job): string {
  return fileStemFromPath(job.filePath) ?? job.name;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cronError(schedule: string, enabled: boolean): string | null {
  const trimmed = schedule.trim();
  if (!trimmed) return enabled ? "Add a cron schedule before enabling this job." : null;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return "Use a 5-field cron expression like */30 * * * *.";
  return null;
}

function shortPath(value: string): string {
  const parts = value.split("/").filter(Boolean);
  if (parts.length <= 3) return value;
  return `.../${parts.slice(-3).join("/")}`;
}

function humanSchedule(schedule: string | null): string {
  if (!schedule) return "No schedule";
  try {
    return cronstrue.toString(schedule, { use24HourTimeFormat: false });
  } catch {
    return `Cron: ${schedule.trim()}`;
  }
}

function triggerSourceLabel(run: JobRun): string {
  return run.config.triggerSource === "scheduled" ? "Scheduled" : "Manual";
}

function useActiveRun(job: Job | null, agents: Agent[]) {
  return useMemo(() => {
    if (!job?.lastRunId || !job.lastRunStatus || !ACTIVE_RUN_STATUSES.includes(job.lastRunStatus)) return null;
    return agents.find((agent) => agent.name.startsWith(`job-${job.name}-`) || agent.name.endsWith(job.lastRunId!.slice(0, 8))) ?? null;
  }, [agents, job]);
}

export function JobsPane({ open, agents, onOpenAgent, enabledAgentTypes, footer }: JobsPaneProps): JSX.Element {
  const navigate = useNavigate();
  const { jobId: routeJobId, section: routeSection } = useParams();
  const { iconColor } = useIconColor();
  const { instanceName } = useInstanceName();
  const { data: jobs = [], isLoading, error } = useJobs(open);
  const { addJob, runNow, setEnabled, updateJob, removeJob } = useJobActions();
  const [isAddingJob, setIsAddingJob] = useState(false);
  const [addJobStep, setAddJobStep] = useState<AddJobStep>("choose");
  const [addJobDirectory, setAddJobDirectory] = useState("");
  const [manualScanDirectory, setManualScanDirectory] = useState<string | null>(null);
  const [availableJobsForceKey, setAvailableJobsForceKey] = useState(0);
  const [actionErrorByJobId, _setActionErrorByJobId] = useState<Record<string, string>>({});
  const [justAddedJobId, setJustAddedJobId] = useState<string | null>(null);
  const selectedJob = jobs.find((job) => job.id === routeJobId) ?? null;
  const tab: DetailTab = routeSection === "prompt" || routeSection === "history" ? routeSection : "configure";
  const history = useJobHistory(selectedJob);
  const activeRunAgent = useActiveRun(selectedJob, agents);
  const availableJobs = useAvailableJobs(open, manualScanDirectory, availableJobsForceKey);

  const selectJob = (job: Job) => {
    setIsAddingJob(false);
    setJustAddedJobId(null);
    navigate(selectedJob?.id === job.id ? "/jobs" : `/jobs/${job.id}`);
  };

  const openAddJob = () => {
    setIsAddingJob(true);
    setAddJobStep("choose");
    setJustAddedJobId(null);
  };

  const showDetailPane = !!selectedJob;

  return (
    <section className="flex h-full min-h-0 min-w-0 overflow-hidden bg-background text-foreground" aria-labelledby="jobs-page-title">
            <aside className={cn("flex h-full min-h-0 w-full flex-col overflow-hidden border-r-2 border-border bg-card md:w-[320px] md:shrink-0", showDetailPane && "hidden md:flex")}>
              <div className="flex min-h-14 items-center px-3 pt-[env(safe-area-inset-top)]">
                <div className="flex items-center gap-2.5">
                  <img src={`/icons/${iconColor}/brand-icon.svg`} alt="" className="h-7 w-7 shrink-0 object-contain" />
                  <div className="flex min-w-0 flex-col justify-center">
                    <div className="text-sm font-bold uppercase tracking-widest text-foreground">Dispatch</div>
                    {instanceName ? (
                      <div title={instanceName} className="truncate text-[11px] leading-tight text-muted-foreground">{instanceName}</div>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="mt-2 flex h-14 items-center border-b border-border px-3">
                <div>
                  <h1 id="jobs-page-title" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Jobs</h1>
                  <div className="text-[11px] text-muted-foreground">Recurring automations</div>
                </div>
                <div className="ml-auto">
                <Button
                  className="justify-start"
                  variant="primary"
                  size="sm"
                  onClick={openAddJob}
                  data-testid="add-job-button"
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Add job
                </Button>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                {error ? (
                  <div className="m-3 rounded-md border border-status-blocked/40 bg-status-blocked/10 p-3 text-sm text-status-blocked">{error instanceof Error ? error.message : "Failed to load jobs."}</div>
                ) : isLoading ? (
                  <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading jobs...</div>
                ) : jobs.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">
                    <div className="rounded-md border border-dashed border-border p-4">
                      <div className="font-medium text-foreground">No jobs added yet.</div>
                      <div className="mt-1 text-xs">Added jobs will appear here with schedule, status, and run controls.</div>
                    </div>
                  </div>
                ) : (
                  <div>
                    {jobs.map((job) => {
                      const actionError = actionErrorByJobId[job.id];
                          return (
                      <div
                        key={job.id}
                        className={cn(
                          "w-full cursor-pointer border-b border-r-4 border-border border-r-transparent px-3 py-2 text-left transition-colors hover:bg-muted/40",
                          selectedJob?.id === job.id && "border-r-primary bg-muted/60"
                        )}
                        onClick={() => selectJob(job)}
                      >
                        <div className="flex items-center gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold leading-5">{job.name}</div>
                            <div className="truncate font-mono text-[11px] text-muted-foreground" title={job.directory}>{shortPath(job.directory)}</div>
                          </div>
                          <Badge className={statusClasses(job.lastRunStatus)}>
                            <span className="mr-1 hidden sm:inline-flex">{statusIcon(job.lastRunStatus)}</span>
                            {job.lastRunStatus ?? "new"}
                          </Badge>
                        </div>
                        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                          <Clock className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{job.schedule ? `Cron: ${job.schedule}` : "No schedule"}</span>
                          <span className="shrink-0 text-muted-foreground/70">•</span>
                          <span className="shrink-0">{job.enabled ? "enabled" : "disabled"}</span>
                        </div>
                        {actionError ? (
                          <div className="mt-2 rounded border border-status-blocked/30 bg-status-blocked/10 px-2 py-1 text-xs text-status-blocked">
                            {actionError}
                          </div>
                        ) : null}
                      </div>
                    );})}
                  </div>
                )}
              </div>
              <JobsNav
                onOpenAgents={() => navigate("/")}
                onOpenDocs={() => navigate("/docs")}
                onOpenActivity={() => navigate("/activity")}
                onOpenJobs={() => navigate("/jobs")}
                onOpenSettings={() => navigate("/settings")}
              />
            </aside>

            <div className={cn("flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background", showDetailPane ? "flex" : "hidden md:flex")}>
              <div className="min-h-0 flex-1 overflow-hidden">
                {selectedJob ? (
                  <div className="flex h-full min-h-0 flex-col">
                    <div className="flex min-h-14 items-center gap-3 border-b border-border bg-card px-4 pt-[env(safe-area-inset-top)] md:hidden">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          setJustAddedJobId(null);
                          navigate("/jobs");
                        }}
                      >
                        <ArrowLeft className="h-4 w-4" />
                      </Button>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{selectedJob.name}</div>
                        <div className="text-xs text-muted-foreground">Job detail</div>
                      </div>
                    </div>
                  <JobDetail
                    className="min-h-0 flex-1"
                    job={selectedJob}
                    tab={tab}
                    onTabChange={(nextTab) => {
                      navigate(`/jobs/${selectedJob.id}${nextTab === "configure" ? "" : `/${nextTab}`}`);
                    }}
                    history={history.data?.runs ?? []}
                    historyLoading={history.isLoading}
                    activeRunAgent={activeRunAgent}
                    onOpenAgent={onOpenAgent}
                    onRunNow={async (job) => { await runNow.mutateAsync(job); }}
                    onSetEnabled={async (job, enabled) => { await setEnabled.mutateAsync({ job, enabled }); }}
                    enabledAgentTypes={enabledAgentTypes}
                    onUpdateJob={async (job) => {
                      await updateJob.mutateAsync(job);
                    }}
                    onRemoveJob={async (job) => {
                      await removeJob.mutateAsync(job);
                      navigate("/jobs");
                    }}
                    isUpdating={updateJob.isPending}
                    isRemoving={removeJob.isPending}
                    justAdded={justAddedJobId === selectedJob.id}
                    onDismissAdded={() => setJustAddedJobId(null)}
                  />
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center p-8 text-center text-muted-foreground">
                    <div>
                      <AlarmClock className="mx-auto mb-3 h-8 w-8" />
                      <div className="font-medium text-foreground">Select a job</div>
                      <div className="mt-1 max-w-sm text-sm">Use jobs for recurring maintenance, scheduled checks, and repeatable agent workflows that should run without manual prompting.</div>
                    </div>
                  </div>
                )}
              </div>
              {footer}
            </div>
      <AddJobDialog
        open={isAddingJob}
        onOpenChange={(nextOpen) => {
          setIsAddingJob(nextOpen);
          if (!nextOpen) setAddJobStep("choose");
        }}
      >
        <AddJobFlow
          step={addJobStep}
          directory={addJobDirectory}
          setDirectory={setAddJobDirectory}
          setStep={setAddJobStep}
          onScanDirectory={(directory) => {
            setManualScanDirectory(directory);
            setAvailableJobsForceKey((current) => current + 1);
          }}
          onRescanSuggestions={() => {
            setAvailableJobsForceKey((current) => current + 1);
          }}
          onAddJob={async (job) => {
            const added = await addJob.mutateAsync(job);
            setIsAddingJob(false);
            setAddJobStep("choose");
            setJustAddedJobId(added.id);
            navigate(`/jobs/${added.id}`);
          }}
          enabledAgentTypes={enabledAgentTypes}
          availableDirectories={availableJobs.data?.directories ?? []}
          isScanning={availableJobs.isLoading || availableJobs.isFetching}
          scanError={availableJobs.error instanceof Error ? availableJobs.error.message : null}
          isAdding={addJob.isPending}
        />
      </AddJobDialog>
    </section>
  );
}

function JobsNav({
  onOpenAgents,
  onOpenDocs,
  onOpenActivity,
  onOpenJobs,
  onOpenSettings,
}: {
  onOpenAgents: () => void;
  onOpenDocs: () => void;
  onOpenActivity: () => void;
  onOpenJobs: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <TooltipProvider delayDuration={120}>
      <div className="flex items-center justify-around border-t border-border py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={onOpenAgents} aria-label="Agents" data-testid="agents-button" className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground">
              <Bot className="h-5 w-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Agents</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={onOpenJobs} aria-label="Jobs" data-testid="jobs-button" className="rounded-md p-2 text-primary transition-colors hover:text-primary/80">
              <AlarmClock className="h-5 w-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Jobs</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={onOpenActivity} data-testid="activity-button" className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground">
              <Activity className="h-5 w-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Activity</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={onOpenDocs} data-testid="docs-button" className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground">
              <BookOpenText className="h-5 w-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Documentation</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button onClick={onOpenSettings} data-testid="settings-button" className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground">
              <Settings className="h-5 w-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}

function AddJobDialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" />
        <DialogPrimitive.Content className="fixed inset-x-2 bottom-2 top-2 z-50 flex max-h-[calc(100dvh-1rem)] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl outline-none md:left-1/2 md:top-1/2 md:h-[min(760px,88vh)] md:w-[min(760px,calc(100vw-2rem))] md:-translate-x-1/2 md:-translate-y-1/2">
          <DialogPrimitive.Title className="sr-only">Add job</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Choose and configure a recurring Dispatch job.</DialogPrimitive.Description>
          <DialogPrimitive.Close asChild>
            <Button variant="ghost" size="icon" className="absolute right-3 top-3 z-10" aria-label="Close add job">
              <X className="h-4 w-4" />
            </Button>
          </DialogPrimitive.Close>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function AddJobFlow({
  step,
  directory,
  setDirectory,
  setStep,
  onScanDirectory,
  onRescanSuggestions,
  availableDirectories,
  isScanning,
  scanError,
  onAddJob,
  isAdding,
  enabledAgentTypes,
}: {
  step: AddJobStep;
  directory: string;
  setDirectory: (value: string) => void;
  setStep: (step: AddJobStep) => void;
  onScanDirectory: (directory: string) => void;
  onRescanSuggestions: () => void;
  availableDirectories: AvailableJobsDirectory[];
  isScanning: boolean;
  scanError: string | null;
  onAddJob: (job: AddJobConfig) => Promise<void>;
  isAdding: boolean;
  enabledAgentTypes: AgentType[];
}) {
  const [selectedJobFilePath, setSelectedJobFilePath] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [schedule, setSchedule] = useState("");
  const [timeoutMinutes, setTimeoutMinutes] = useState("");
  const [needsInputTimeoutMinutes, setNeedsInputTimeoutMinutes] = useState("");
  const [agentType, setAgentType] = useState<AgentType>(enabledAgentTypes[0] ?? "codex");
  const [fullAccess, setFullAccess] = useState(false);
  const [useWorktree, setUseWorktree] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [additionalInstructions, setAdditionalInstructions] = useState("");
  const [enableImmediately, setEnableImmediately] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sourceTab, setSourceTab] = useState<AddJobSourceTab>("automatic");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const discoveredJobs = useMemo(
    () => availableDirectories.flatMap((entry) => entry.jobs.map((job) => ({ ...job, source: entry.source, directoryError: entry.error }))),
    [availableDirectories]
  );
  const automaticJobs = useMemo(() => discoveredJobs.filter((job) => job.source === "agent"), [discoveredJobs]);
  const manualJobs = useMemo(() => discoveredJobs.filter((job) => job.source === "manual"), [discoveredJobs]);
  const manualDirectoryResult = useMemo(
    () => availableDirectories.find((entry) => entry.source === "manual") ?? null,
    [availableDirectories]
  );
  const selectedJob = useMemo(
    () => discoveredJobs.find((job) => job.filePath === selectedJobFilePath) ?? null,
    [discoveredJobs, selectedJobFilePath]
  );
  const selectedJobRef = useRef<typeof selectedJob>(null);
  const scannedDirectoryCount = availableDirectories.length;
  const scheduleError = cronError(schedule, enableImmediately);
  const canAddConfiguredJob = !!selectedJob && !!displayName.trim() && !scheduleError && !!msFromMinutes(timeoutMinutes) && !!msFromMinutes(needsInputTimeoutMinutes);

  useEffect(() => {
    selectedJobRef.current = selectedJob;
  }, [selectedJob]);

  useEffect(() => {
    const job = selectedJobRef.current;
    if (!job) return;
    setDisplayName(job.name);
    setSchedule(job.schedule ?? "");
    setTimeoutMinutes(minutesFromMs(job.timeoutMs));
    setNeedsInputTimeoutMinutes(minutesFromMs(job.needsInputTimeoutMs));
    setFullAccess(job.fullAccess);
    setUseWorktree(false);
    setBranchName("");
    setAdditionalInstructions("");
    setEnableImmediately(false);
    setAgentType((current) => enabledAgentTypes.includes(current) ? current : enabledAgentTypes[0] ?? "codex");
  }, [enabledAgentTypes, selectedJobFilePath]);

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col overflow-hidden p-4 md:p-8">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className={cn("rounded-full px-2 py-0.5", step === "choose" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>1</span>
          Choose Job
          <span className="text-muted-foreground/50">/</span>
          <span className={cn("rounded-full px-2 py-0.5", step === "configure" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>2</span>
          Configure
      </div>

      {step === "choose" ? (
        <div className="mt-6 flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2">
            <TabButton active={sourceTab === "automatic"} onClick={() => setSourceTab("automatic")} icon={<RefreshCw className="h-4 w-4" />}>Automatic</TabButton>
            <TabButton active={sourceTab === "manual"} onClick={() => setSourceTab("manual")} icon={<Search className="h-4 w-4" />}>Manual</TabButton>
          </div>

          <ScrollArea className="mt-4 min-h-0 flex-1 pr-1">
            {sourceTab === "automatic" ? (
              <div>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">Suggested jobs</div>
                    <p className="mt-1 text-xs text-muted-foreground">Dispatch scans recent agent working directories for `.dispatch/jobs/*.md` workflows.</p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={onRescanSuggestions} disabled={isScanning}>
                    {isScanning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                    Rescan
                  </Button>
                </div>
                {scanError ? (
                  <div className="mt-3 rounded-md border border-status-blocked/40 bg-status-blocked/10 p-3 text-sm text-status-blocked">{scanError}</div>
                ) : automaticJobs.length > 0 ? (
                  <div className="mt-3 space-y-2">
                    {automaticJobs.slice(0, 5).map((job) => (
                      <button
                        key={job.filePath}
                        type="button"
                        disabled={job.alreadyConfigured}
                        className={cn("w-full rounded-md border border-border p-3 text-left", job.alreadyConfigured ? "opacity-60" : "hover:bg-muted/40")}
                        onClick={() => {
                          setSelectedJobFilePath(job.filePath);
                          setSubmitError(null);
                          setStep("configure");
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{job.name}</div>
                            <div className="truncate font-mono text-xs text-muted-foreground">{shortPath(job.directory)}</div>
                          </div>
                          <Badge>{job.alreadyConfigured ? "Added" : "Agent"}</Badge>
                        </div>
                        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span>{humanSchedule(job.schedule)}</span>
                          {!job.alreadyConfigured ? <span className="font-medium text-primary">Configure</span> : null}
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="mt-3 rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
                    {scannedDirectoryCount > 0 ? "No job files found in recent agent working directories." : "No recent agent directories to scan yet."}
                  </div>
                )}
              </div>
            ) : (
              <div>
                <div>
                  <div className="text-sm font-medium">Scan another project</div>
                  <p className="mt-1 text-xs text-muted-foreground">Pick a directory, scan it, and any jobs found will appear inline below.</p>
                </div>
                <PathInput
                  className="mt-4"
                  value={directory}
                  onChange={setDirectory}
                  label="Project path containing `.dispatch/jobs`"
                  placeholder="~/code/project"
                  id="job-directory"
                  data-testid="job-directory-input"
                />
                <div className="mt-3 flex justify-end">
                  <Button
                    variant="primary"
                    disabled={!directory.trim() || isScanning}
                    onClick={() => onScanDirectory(directory)}
                    data-testid="scan-jobs-button"
                  >
                    {isScanning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
                    Scan directory
                  </Button>
                </div>
                {scanError ? (
                  <div className="mt-4 rounded-md border border-status-blocked/40 bg-status-blocked/10 p-3 text-sm text-status-blocked">{scanError}</div>
                ) : null}
                {manualDirectoryResult ? (
                  <div className="mt-4">
                    <div className="text-xs font-medium text-muted-foreground">Scan results</div>
                    {manualJobs.length > 0 ? (
                      <div className="mt-2 space-y-2">
                        {manualJobs.map((job) => (
                          <button
                            key={job.filePath}
                            type="button"
                            disabled={job.alreadyConfigured}
                            className={cn("w-full rounded-md border border-border p-3 text-left", job.alreadyConfigured ? "opacity-60" : "hover:bg-muted/40")}
                            onClick={() => {
                              setSelectedJobFilePath(job.filePath);
                              setSubmitError(null);
                              setStep("configure");
                            }}
                          >
                            <div className="flex items-center gap-2">
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium">{job.name}</div>
                                <div className="truncate font-mono text-xs text-muted-foreground">{shortPath(job.directory)}</div>
                              </div>
                              <Badge>{job.alreadyConfigured ? "Added" : "Manual"}</Badge>
                            </div>
                            <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                              <span>{humanSchedule(job.schedule)}</span>
                              {!job.alreadyConfigured ? <span className="font-medium text-primary">Configure</span> : null}
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-2 rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
                        No jobs found in that directory.
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            )}
          </ScrollArea>
        </div>
      ) : (
        <div className="mt-6 flex min-h-0 flex-1 flex-col">
          <ScrollArea className="min-h-0 flex-1 pr-1">
            <div className="grid min-w-0 gap-4">
            {selectedJob ? (
              <>
                <div className="min-w-0 rounded-md border border-border bg-background/50 p-4">
                  <div className="text-sm font-medium">Review job</div>
                  <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{selectedJob.filePath}</div>
                  <label className="mt-4 flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-sm">
                    <span>
                      <span className="block font-medium text-foreground">Enabled</span>
                      <span className="block text-xs text-muted-foreground">Run this job on its schedule after adding it.</span>
                    </span>
                    <SwitchToggle checked={enableImmediately} onCheckedChange={setEnableImmediately} ariaLabel="Enable job" />
                  </label>
                  <div className="mt-4 grid min-w-0 gap-3 md:grid-cols-2">
                    <div className="min-w-0 space-y-1 md:col-span-2">
                      <label className="text-sm text-muted-foreground" htmlFor="job-display-name">Name</label>
                      <Input id="job-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
                    </div>
                    <div className="min-w-0 space-y-1">
                      <label className="text-sm text-muted-foreground" htmlFor="job-schedule">Cron schedule</label>
                      <Input id="job-schedule" value={schedule} onChange={(event) => setSchedule(event.target.value)} placeholder="*/30 * * * *" className="font-mono text-xs" />
                      {scheduleError ? <div className="text-xs text-status-blocked">{scheduleError}</div> : null}
                      {!scheduleError && schedule.trim() ? <div className="text-xs text-muted-foreground">{humanSchedule(schedule)}</div> : null}
                    </div>
                    <div className="min-w-0 space-y-1">
                      <label className="text-sm text-muted-foreground">Agent type</label>
                      <Select value={agentType} onValueChange={(value) => setAgentType(value as AgentType)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {enabledAgentTypes.map((type) => (
                            <SelectItem key={type} value={type}>{AGENT_TYPE_LABELS[type]}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>

                <div className="min-w-0 rounded-md border border-border bg-background/50 p-4">
                  <button type="button" className="flex w-full items-center justify-between gap-3 text-left" onClick={() => setAdvancedOpen((current) => !current)}>
                    <div>
                      <div className="text-sm font-medium">Advanced settings</div>
                      <div className="mt-1 text-xs text-muted-foreground">Timeouts, worktree behavior, permissions, and additional run instructions.</div>
                    </div>
                    <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", advancedOpen && "rotate-180")} />
                  </button>
                  <div
                    className={cn(
                      "grid min-w-0 overflow-hidden transition-all duration-200 ease-out",
                      advancedOpen ? "mt-4 grid-rows-[1fr] opacity-100" : "mt-0 grid-rows-[0fr] opacity-0",
                    )}
                    aria-hidden={!advancedOpen}
                  >
                    <div className="min-h-0">
                      <div className="grid min-w-0 gap-3 md:grid-cols-2">
                      <div className="min-w-0 space-y-1">
                        <label className="text-sm text-muted-foreground" htmlFor="job-timeout">Run timeout, minutes</label>
                        <Input id="job-timeout" value={timeoutMinutes} onChange={(event) => setTimeoutMinutes(event.target.value)} inputMode="numeric" />
                      </div>
                      <div className="min-w-0 space-y-1">
                        <label className="text-sm text-muted-foreground" htmlFor="job-needs-input-timeout">Wait for input, minutes</label>
                        <Input id="job-needs-input-timeout" value={needsInputTimeoutMinutes} onChange={(event) => setNeedsInputTimeoutMinutes(event.target.value)} inputMode="numeric" />
                      </div>
                      <JobWorktreeOption
                        checked={useWorktree}
                        branchName={branchName}
                        onCheckedChange={setUseWorktree}
                        onBranchNameChange={setBranchName}
                      />
                      <JobFullAccessOption checked={fullAccess} onCheckedChange={setFullAccess} />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="min-w-0 rounded-md border border-border bg-muted/20 p-4">
                  <div className="text-sm font-medium">Prompt</div>
                  <ScrollArea className="mt-2 max-h-60 rounded-md border border-border bg-background/60">
                    <pre className="whitespace-pre-wrap p-3 font-mono text-xs leading-5 text-foreground">
                      {selectedJob.prompt?.trim() || selectedJob.promptPreview || "No prompt configured."}
                    </pre>
                  </ScrollArea>
                  <div className="mt-4 space-y-1">
                    <label className="text-sm font-medium text-foreground" htmlFor="job-additional-instructions">Additional instructions</label>
                    <p className="text-xs text-muted-foreground">Optional instructions appended when the job runs.</p>
                    <textarea
                      id="job-additional-instructions"
                      value={additionalInstructions}
                      onChange={(event) => setAdditionalInstructions(event.target.value)}
                      placeholder="Optional instructions appended when the job runs"
                      className="mt-2 min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                </div>
              </>
            ) : (
              <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">Choose a job before configuring it.</div>
            )}
            {submitError ? (
              <div className="rounded-md border border-status-blocked/40 bg-status-blocked/10 p-3 text-sm text-status-blocked">{submitError}</div>
            ) : null}
          </div>
        </ScrollArea>
          <div className="mt-4 flex shrink-0 justify-end gap-2 border-t border-border/70 pt-4">
            <Button variant="ghost" onClick={() => setStep("choose")}>Back</Button>
            <Button
              variant="primary"
              disabled={!canAddConfiguredJob || isAdding}
              onClick={() => {
                if (!selectedJob) return;
                setSubmitError(null);
                void onAddJob({
                  name: selectedJob.fileStem,
                  directory: selectedJob.directory,
                  displayName,
                  schedule: schedule.trim() || null,
                  timeoutMs: msFromMinutes(timeoutMinutes),
                  needsInputTimeoutMs: msFromMinutes(needsInputTimeoutMinutes),
                  agentType,
                  useWorktree,
                  branchName: useWorktree ? branchName : null,
                  fullAccess,
                  additionalInstructions,
                  enabled: enableImmediately,
                }).catch((error) => setSubmitError(errorMessage(error)));
              }}
            >
              {isAdding ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Add job
            </Button>
          </div>
        </div>
      )}
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
  activeRunAgent,
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
}: {
  className?: string;
  job: Job;
  tab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  history: JobRun[];
  historyLoading: boolean;
  activeRunAgent: Agent | null;
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
  const [detailActionError, setDetailActionError] = useState<string | null>(null);
  return (
    <div className={cn("flex h-full min-h-0 flex-col p-4 md:p-6", className)}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-semibold">{job.name}</h2>
          <div className="mt-1 truncate font-mono text-xs text-muted-foreground" title={job.filePath ?? job.directory}>{job.filePath ?? job.directory}</div>
        </div>
        <Button
          size="sm"
          variant="primary"
          disabled={isUpdating}
          onClick={() => {
            setDetailActionError(null);
            void onRunNow(job).catch((error) => setDetailActionError(errorMessage(error)));
          }}
        >
          <Play className="mr-2 h-4 w-4" />
          Run Now
        </Button>
      </div>

      {activeRunAgent ? (
        <div className="mt-4 rounded-md border border-status-working/40 bg-status-working/10 p-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-status-working">Active run is attached to a live agent session.</div>
              <div className="truncate text-xs text-muted-foreground">{activeRunAgent.name}</div>
            </div>
            <Button size="sm" onClick={() => void onOpenAgent(activeRunAgent)}>
              <Terminal className="mr-2 h-4 w-4" />
              Open session
            </Button>
          </div>
        </div>
      ) : null}

      {justAdded ? (
        <div className="mt-4 rounded-md border border-status-done/40 bg-status-done/10 p-4">
          <div className="text-sm font-semibold text-status-done">Job added</div>
          <div className="mt-1 text-sm text-muted-foreground">
            {job.enabled && job.nextRun ? `Scheduled next run: ${formatDate(job.nextRun)}.` : "This job is saved but not enabled on a schedule yet."}
          </div>
          {detailActionError ? <div className="mt-3 rounded border border-status-blocked/30 bg-status-blocked/10 p-2 text-sm text-status-blocked">{detailActionError}</div> : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setDetailActionError(null);
                void onRunNow(job).catch((error) => setDetailActionError(errorMessage(error)));
              }}
            >
              <Play className="mr-2 h-4 w-4" />
              Run once
            </Button>
            {!job.enabled ? (
              <Button
                size="sm"
                variant="default"
                disabled={!job.schedule}
                onClick={() => {
                  setDetailActionError(null);
                  void onSetEnabled(job, true).catch((error) => setDetailActionError(errorMessage(error)));
                }}
              >
                Enable schedule
              </Button>
            ) : null}
            <Button size="sm" variant="default" onClick={() => { onDismissAdded(); onTabChange("configure"); }}>Edit settings</Button>
            <Button size="sm" variant="ghost" onClick={() => { onDismissAdded(); onTabChange("history"); }}>View history</Button>
          </div>
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-2 border-b border-border">
        <TabButton active={tab === "configure"} onClick={() => onTabChange("configure")} icon={<Settings className="h-4 w-4" />}>Configure</TabButton>
        <TabButton active={tab === "prompt"} onClick={() => onTabChange("prompt")} icon={<MessageSquareText className="h-4 w-4" />}>Prompt</TabButton>
        <TabButton active={tab === "history"} onClick={() => onTabChange("history")} icon={<History className="h-4 w-4" />}>History</TabButton>
        <Badge className={cn("mb-2 self-center", statusClasses(job.lastRunStatus))}>
          <span className="mr-1">{statusIcon(job.lastRunStatus)}</span>
          {job.lastRunStatus ?? "never run"}
        </Badge>
      </div>

      {tab === "history" ? (
        <div className="min-h-0 flex-1">
          <HistoryTab runs={history} loading={historyLoading} />
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1 pr-1">
          {tab === "configure" ? <SettingsTab job={job} enabledAgentTypes={enabledAgentTypes} onUpdateJob={onUpdateJob} onRemoveJob={onRemoveJob} isUpdating={isUpdating} isRemoving={isRemoving} /> : null}
          {tab === "prompt" ? <PromptTab job={job} onUpdateJob={onUpdateJob} isUpdating={isUpdating} /> : null}
        </ScrollArea>
      )}
    </div>
  );
}

function TabButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className={cn("flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors", active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
      onClick={onClick}
    >
      {icon}
      {children}
    </button>
  );
}

function JobWorktreeOption({
  checked,
  branchName,
  onCheckedChange,
  onBranchNameChange,
}: {
  checked: boolean;
  branchName: string;
  onCheckedChange: (checked: boolean) => void;
  onBranchNameChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 px-3 py-3 md:col-span-2">
      <label className="flex cursor-pointer items-start gap-3">
        <Checkbox
          checked={checked}
          onCheckedChange={() => onCheckedChange(!checked)}
          className="mt-0.5"
          title="Toggle git worktree"
        />
        <span className="space-y-1">
          <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <GitBranch className="h-3.5 w-3.5" />
            Run in a git worktree
          </span>
          <span className="block text-xs text-muted-foreground">
            Creates an isolated worktree and branch when this job runs.
          </span>
        </span>
      </label>
      {checked ? (
        <div className="ml-8 w-[calc(100%-2rem)]">
          <Input
            value={branchName}
            onChange={(event) => onBranchNameChange(event.target.value)}
            placeholder="branch name (auto-generated if empty)"
          />
        </div>
      ) : null}
    </div>
  );
}

function JobFullAccessOption({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3 md:col-span-2">
      <Checkbox
        checked={checked}
        onCheckedChange={() => onCheckedChange(!checked)}
        className="mt-0.5"
        title="Toggle full access"
      />
      <span className="space-y-1">
        <span className="block text-sm font-medium text-foreground">Run in full access mode</span>
        <span className="block text-xs text-muted-foreground">
          Starts the selected agent with its most permissive supported execution mode.
        </span>
      </span>
    </label>
  );
}

function SwitchToggle({
  checked,
  onCheckedChange,
  ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-transparent p-0.5 transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background",
        checked ? "bg-primary" : "bg-muted"
      )}
    >
      <span
        className={cn(
          "h-5 w-5 rounded-full bg-background shadow-sm transition-transform",
          checked ? "translate-x-5" : "translate-x-0"
        )}
      />
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
  const [timeoutMinutes, setTimeoutMinutes] = useState(minutesFromMs(job.timeoutMs));
  const [needsInputTimeoutMinutes, setNeedsInputTimeoutMinutes] = useState(minutesFromMs(job.needsInputTimeoutMs));
  const [agentType, setAgentType] = useState<AgentType>(job.agentType);
  const [fullAccess, setFullAccess] = useState(job.fullAccess);
  const [useWorktree, setUseWorktree] = useState(job.useWorktree);
  const [branchName, setBranchName] = useState(job.branchName ?? "");
  const [enabled, setEnabled] = useState(job.enabled);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const scheduleError = cronError(schedule, enabled);
  const canSave = !!displayName.trim() && !scheduleError && !!msFromMinutes(timeoutMinutes) && !!msFromMinutes(needsInputTimeoutMinutes);

  useEffect(() => {
    setDisplayName(job.name);
    setSchedule(job.schedule ?? "");
    setTimeoutMinutes(minutesFromMs(job.timeoutMs));
    setNeedsInputTimeoutMinutes(minutesFromMs(job.needsInputTimeoutMs));
    setAgentType(job.agentType);
    setFullAccess(job.fullAccess);
    setUseWorktree(job.useWorktree);
    setBranchName(job.branchName ?? "");
    setEnabled(job.enabled);
    setSaveError(null);
    setRemoveError(null);
    setRemoveDialogOpen(false);
    setSaved(false);
  }, [job]);

  return (
    <div className="mt-4 grid gap-4">
      <div className="rounded-md border border-border bg-background/50 p-4">
        <div className="text-sm font-medium">Job configuration</div>
        <p className="mt-1 text-xs text-muted-foreground">These values are used when the schedule or Run button starts this job.</p>
        <label className="mt-4 flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-sm">
          <span>
            <span className="block font-medium text-foreground">Enabled</span>
            <span className="block text-xs text-muted-foreground">Run this job on its saved schedule.</span>
          </span>
          <SwitchToggle checked={enabled} onCheckedChange={setEnabled} ariaLabel="Enable job" />
        </label>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="space-y-1 md:col-span-2">
            <label className="text-sm text-muted-foreground" htmlFor={`settings-name-${job.id}`}>Name</label>
            <Input id={`settings-name-${job.id}`} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-sm text-muted-foreground" htmlFor={`settings-schedule-${job.id}`}>Cron schedule</label>
            <Input id={`settings-schedule-${job.id}`} value={schedule} onChange={(event) => setSchedule(event.target.value)} placeholder="*/30 * * * *" className="font-mono text-xs" />
            {scheduleError ? <div className="text-xs text-status-blocked">{scheduleError}</div> : null}
            {!scheduleError && schedule.trim() ? <div className="text-xs text-muted-foreground">{humanSchedule(schedule)}</div> : null}
          </div>
          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">Agent type</label>
            <Select value={agentType} onValueChange={(value) => setAgentType(value as AgentType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {enabledAgentTypes.map((type) => (
                  <SelectItem key={type} value={type}>{AGENT_TYPE_LABELS[type]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-sm text-muted-foreground" htmlFor={`settings-timeout-${job.id}`}>Run timeout, minutes</label>
            <Input id={`settings-timeout-${job.id}`} value={timeoutMinutes} onChange={(event) => setTimeoutMinutes(event.target.value)} inputMode="numeric" />
          </div>
          <div className="space-y-1">
            <label className="text-sm text-muted-foreground" htmlFor={`settings-needs-input-${job.id}`}>Wait for input, minutes</label>
            <Input id={`settings-needs-input-${job.id}`} value={needsInputTimeoutMinutes} onChange={(event) => setNeedsInputTimeoutMinutes(event.target.value)} inputMode="numeric" />
          </div>
        </div>
        <div className="mt-4 grid gap-3">
          <JobWorktreeOption
            checked={useWorktree}
            branchName={branchName}
            onCheckedChange={setUseWorktree}
            onBranchNameChange={setBranchName}
          />
          <JobFullAccessOption checked={fullAccess} onCheckedChange={setFullAccess} />
        </div>
        {saveError ? <div className="mt-4 rounded-md border border-status-blocked/40 bg-status-blocked/10 p-3 text-sm text-status-blocked">{saveError}</div> : null}
        {saved ? <div className="mt-4 rounded-md border border-status-done/40 bg-status-done/10 p-3 text-sm text-status-done">Settings saved.</div> : null}
        <div className="mt-4 flex justify-end">
          <Button
            variant="primary"
            disabled={!canSave || isUpdating}
            onClick={() => {
              setSaveError(null);
              setSaved(false);
              void onUpdateJob({
                name: jobFileStem(job),
                directory: job.directory,
                displayName,
                schedule: schedule.trim() || null,
                timeoutMs: msFromMinutes(timeoutMinutes),
                needsInputTimeoutMs: msFromMinutes(needsInputTimeoutMinutes),
                agentType,
                useWorktree,
                branchName: useWorktree ? branchName : null,
                fullAccess,
                additionalInstructions: job.additionalInstructions ?? "",
                enabled,
              }).then(() => {
                setSaved(true);
              }).catch((error) => {
                setSaveError(errorMessage(error));
              });
            }}
          >
            {isUpdating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </div>
      <div className="rounded-md border border-status-blocked/30 bg-status-blocked/5 p-4">
        <div className="text-sm font-medium text-status-blocked">Remove job</div>
        <p className="mt-1 text-xs text-muted-foreground">
          Remove this saved job, schedule, and run history from this Dispatch instance. This does not delete the markdown job file.
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
        {removeError ? <div className="mt-3 rounded-md border border-status-blocked/40 bg-status-blocked/10 p-3 text-sm text-status-blocked">{removeError}</div> : null}
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
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 shadow-xl outline-none">
          <DialogPrimitive.Title className="text-base font-semibold">Remove job?</DialogPrimitive.Title>
          <DialogPrimitive.Description className="mt-2 text-sm text-muted-foreground">
            Remove <span className="font-medium text-foreground">{job.name}</span> from this Dispatch instance? This removes its saved schedule and run history, but does not delete the markdown job file.
          </DialogPrimitive.Description>
          <div className="mt-5 flex justify-end gap-2">
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" disabled={isRemoving}>Cancel</Button>
            </DialogPrimitive.Close>
            <Button variant="destructive" disabled={isRemoving} onClick={onConfirm}>
              {isRemoving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
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
  const [additionalInstructions, setAdditionalInstructions] = useState(job.additionalInstructions ?? "");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setAdditionalInstructions(job.additionalInstructions ?? "");
    setSaveError(null);
    setSaved(false);
  }, [job]);

  return (
    <div className="mt-4 grid gap-4">
      <div className="rounded-md border border-border bg-background/50 p-4">
        <div className="text-sm font-medium">Prompt</div>
        <p className="mt-1 text-xs text-muted-foreground">This prompt is read from the saved job file and is read-only for now.</p>
        <ScrollArea className="mt-4 h-[min(45vh,360px)] rounded-md border border-border bg-muted/20">
          <pre className="whitespace-pre-wrap p-4 font-mono text-xs leading-5 text-foreground">
            {job.prompt?.trim() || "No prompt configured."}
          </pre>
        </ScrollArea>
        <div className="mt-4 space-y-1">
          <label className="text-sm font-medium text-foreground" htmlFor={`prompt-instructions-${job.id}`}>Additional instructions</label>
          <p className="text-xs text-muted-foreground">Optional instructions appended when the job runs.</p>
          <textarea
            id={`prompt-instructions-${job.id}`}
            value={additionalInstructions}
            onChange={(event) => setAdditionalInstructions(event.target.value)}
            placeholder="Optional instructions appended when the job runs"
            className="mt-2 min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        {saveError ? <div className="mt-4 rounded-md border border-status-blocked/40 bg-status-blocked/10 p-3 text-sm text-status-blocked">{saveError}</div> : null}
        {saved ? <div className="mt-4 rounded-md border border-status-done/40 bg-status-done/10 p-3 text-sm text-status-done">Prompt settings saved.</div> : null}
        <div className="mt-4 flex justify-end">
          <Button
            variant="primary"
            disabled={isUpdating}
            onClick={() => {
              setSaveError(null);
              setSaved(false);
              void onUpdateJob({
                name: jobFileStem(job),
                directory: job.directory,
                displayName: job.name,
                schedule: job.schedule,
                timeoutMs: job.timeoutMs ?? undefined,
                needsInputTimeoutMs: job.needsInputTimeoutMs ?? undefined,
                agentType: job.agentType,
                useWorktree: job.useWorktree,
                branchName: job.branchName,
                fullAccess: job.fullAccess,
                additionalInstructions,
                enabled: job.enabled,
              }).then(() => {
                setSaved(true);
              }).catch((error) => {
                setSaveError(errorMessage(error));
              });
            }}
          >
            {isUpdating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save prompt settings
          </Button>
        </div>
      </div>
    </div>
  );
}

function HistoryTab({ runs, loading }: { runs: JobRun[]; loading: boolean }) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null;
  return (
    <div className="mt-4 grid h-full min-h-0 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <div className="space-y-2 overflow-y-auto pr-1">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading history...</div>
        ) : runs.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">No runs yet.</div>
        ) : runs.map((run) => (
          <button
            key={run.id}
            type="button"
            className={cn("w-full rounded-md border border-border bg-background/50 p-3 text-left hover:bg-muted/40", selectedRun?.id === run.id && "border-primary/60 bg-muted/60")}
            onClick={() => setSelectedRunId(run.id)}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs">{run.id.slice(0, 8)}</span>
              <Badge className={statusClasses(run.status)}>{run.status}</Badge>
            </div>
            <div className="mt-2 text-xs text-muted-foreground">{formatDate(run.startedAt)}</div>
            <div className="text-xs text-muted-foreground">Started by: {triggerSourceLabel(run)}</div>
            <div className="text-xs text-muted-foreground">Duration: {formatDuration(run.durationMs)}</div>
          </button>
        ))}
      </div>
      <ScrollArea className="min-h-0 h-full pr-1">
        <RunReport run={selectedRun} />
      </ScrollArea>
    </div>
  );
}

function RunReport({ run }: { run: JobRun | null }) {
  if (!run) return <div className="rounded-md border border-border p-4 text-sm text-muted-foreground">Select a run to inspect its structured report.</div>;
  if (!run.report) {
    return <div className="rounded-md border border-border p-4 text-sm text-muted-foreground">This run has no structured report yet.</div>;
  }
  return (
    <div className="rounded-md border border-border bg-background/50 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className={statusClasses(run.status)}>{run.status}</Badge>
        <Badge>{triggerSourceLabel(run)}</Badge>
        <span className="text-sm font-medium">{run.report.summary}</span>
      </div>
      <div className="mt-4 space-y-3">
        {run.report.tasks.map((task, index) => (
          <div key={`${task.name}-${index}`} className="rounded-md border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="font-medium">{task.name}</div>
              <Badge variant={task.status === "error" ? "error" : "default"}>{task.status}</Badge>
            </div>
            {task.summary ? <div className="mt-1 text-sm text-muted-foreground">{task.summary}</div> : null}
            {task.errors?.map((error, errorIndex) => (
              <div key={errorIndex} className="mt-2 rounded border border-status-blocked/30 bg-status-blocked/10 p-2 text-sm text-status-blocked">
                {error.message}
                {error.action ? <div className="mt-1 text-xs text-muted-foreground">{error.action}</div> : null}
              </div>
            ))}
            {task.logs?.slice(-5).map((log, logIndex) => (
              <div key={logIndex} className="mt-2 font-mono text-xs text-muted-foreground">[{log.level}] {log.message}</div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
