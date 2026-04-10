import * as DialogPrimitive from "@radix-ui/react-dialog";
import cronstrue from "cronstrue";
import { Activity, AlarmClock, ArrowLeft, BookOpenText, Bot, CheckCircle2, ChevronDown, Clock, GitBranch, History, Loader2, LoaderCircle, MessageSquareText, Play, Plus, Settings, Terminal, Trash2, X, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import { Bar, BarChart, XAxis } from "recharts";
import { type AddJobConfig, type Job, type JobRun, type JobRunStatus, useJobActions, useJobHistory, useJobs, useJobStats } from "@/hooks/use-jobs";
import { ChartContainer, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent, type ChartConfig } from "@/components/ui/chart";
import { StatCard } from "@/components/app/stat-card";
import { formatRelativeTime } from "@/lib/format";
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

const ACTIVE_RUN_STATUSES: JobRunStatus[] = ["started", "running", "needs_input"];

function statusClasses(status: JobRunStatus | null): string {
  if (status === "completed") return "border-status-done/45 bg-status-done/15 text-status-done";
  if (status === "failed" || status === "timed_out" || status === "crashed") return "border-status-blocked/45 bg-status-blocked/15 text-status-blocked";
  if (status === "needs_input") return "border-status-waiting/45 bg-status-waiting/15 text-status-waiting";
  if (status === "started" || status === "running") return "border-status-working/45 bg-status-working/15 text-status-working";
  return "border-border bg-muted/35 text-muted-foreground";
}

function statusTextColor(status: JobRunStatus | null): string {
  if (status === "completed") return "text-status-done";
  if (status === "failed" || status === "timed_out" || status === "crashed") return "text-status-blocked";
  if (status === "needs_input") return "text-status-waiting";
  if (status === "started" || status === "running") return "text-status-working";
  return "text-muted-foreground";
}

function statusIcon(status: JobRunStatus | null): JSX.Element | null {
  if (status === "completed") return <CheckCircle2 className="h-3.5 w-3.5" />;
  if (status === "failed" || status === "timed_out" || status === "crashed") return <XCircle className="h-3.5 w-3.5" />;
  if (status === "started" || status === "running" || status === "needs_input") return <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" />;
  return null;
}

function statusDotColor(status: JobRunStatus | null): string {
  if (status === "completed") return "bg-status-done";
  if (status === "failed" || status === "timed_out" || status === "crashed") return "bg-status-blocked";
  if (status === "needs_input") return "bg-status-waiting";
  if (status === "started" || status === "running") return "bg-status-working";
  return "bg-muted-foreground";
}

function statusTextColor(status: JobRunStatus | null): string {
  if (status === "completed") return "text-status-done";
  if (status === "failed" || status === "timed_out" || status === "crashed") return "text-status-blocked";
  if (status === "needs_input") return "text-status-waiting";
  if (status === "started" || status === "running") return "text-status-working";
  return "text-muted-foreground";
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
  const { jobId: routeJobId, section: routeSection, runId: routeRunId } = useParams();
  const { iconColor } = useIconColor();
  const { instanceName } = useInstanceName();
  const { data: jobs = [], isLoading, error } = useJobs(open);
  const { addJob, runNow, setEnabled, updateJob, removeJob } = useJobActions();
  const [isAddingJob, setIsAddingJob] = useState(false);
  const [actionErrorByJobId, _setActionErrorByJobId] = useState<Record<string, string>>({});
  const [justAddedJobId, setJustAddedJobId] = useState<string | null>(null);
  const showOverview = routeJobId === "overview";
  const selectedJob = showOverview ? null : (jobs.find((job) => job.id === routeJobId) ?? null);
  const tab: DetailTab = routeSection === "prompt" || routeSection === "history" ? routeSection : "configure";
  const history = useJobHistory(selectedJob);
  const activeRunAgent = useActiveRun(selectedJob, agents);
  const jobStats = useJobStats(open && !selectedJob);

  const selectJob = (job: Job) => {
    setIsAddingJob(false);
    setJustAddedJobId(null);
    navigate(selectedJob?.id === job.id ? "/jobs" : `/jobs/${job.id}`);
  };

  const openAddJob = () => {
    setIsAddingJob(true);
    setJustAddedJobId(null);
  };

  const showDetailPane = !!selectedJob || showOverview;

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
                    <button
                      className="flex w-full items-center gap-2 border-b border-border px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/40 md:hidden"
                      onClick={() => navigate("/jobs/overview")}
                    >
                      <Activity className="h-3.5 w-3.5" />
                      <span>Overview</span>
                    </button>
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
                    selectedRunId={routeRunId ?? null}
                    onSelectRun={(runId) => {
                      navigate(runId ? `/jobs/${selectedJob.id}/history/${runId}` : `/jobs/${selectedJob.id}/history`);
                    }}
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
                  <div className="flex h-full min-h-0 flex-col">
                    {showOverview && (
                      <div className="flex min-h-14 items-center gap-3 border-b border-border bg-card px-4 pt-[env(safe-area-inset-top)] md:hidden">
                        <Button variant="ghost" size="icon" aria-label="Back to jobs" onClick={() => navigate("/jobs")}>
                          <ArrowLeft className="h-4 w-4" />
                        </Button>
                        <div className="text-sm font-semibold">Overview</div>
                      </div>
                    )}
                    <JobsOverview
                      jobs={jobs}
                      stats={jobStats.data ?? null}
                      statsLoading={jobStats.isLoading}
                      onSelectJob={selectJob}
                      onSelectRun={(jobId, runId) => navigate(`/jobs/${jobId}/history/${runId}`)}
                    />
                  </div>
                )}
              </div>
              {footer}
            </div>
      <AddJobDialog
        open={isAddingJob}
        onOpenChange={setIsAddingJob}
      >
        <AddJobFlow
          onAddJob={async (job) => {
            const added = await addJob.mutateAsync(job);
            setIsAddingJob(false);
            setJustAddedJobId(added.id);
            navigate(`/jobs/${added.id}`);
          }}
          isAdding={addJob.isPending}
          enabledAgentTypes={enabledAgentTypes}
        />
      </AddJobDialog>
    </section>
  );
}

function formatTimeUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms) || ms < 0) return "now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "< 1m";
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `in ${hours}h ${remMins}m` : `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

function formatTimeUntilDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (isToday) return `Today at ${time}`;
  if (isTomorrow) return `Tomorrow at ${time}`;
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function JobsOverview({ jobs, stats, statsLoading, onSelectJob, onSelectRun }: {
  jobs: Job[];
  stats: import("@/hooks/use-jobs").JobStats | null;
  statsLoading: boolean;
  onSelectJob: (job: Job) => void;
  onSelectRun: (jobId: string, runId: string) => void;
}) {
  const upcomingJobs = useMemo(() => {
    return jobs
      .filter((j) => j.nextRun)
      .sort((a, b) => new Date(a.nextRun!).getTime() - new Date(b.nextRun!).getTime())
      .slice(0, 5);
  }, [jobs]);

  const recentRuns = stats?.recentRuns ?? [];
  const metrics = stats?.stats ?? null;
  const hasAnyData = jobs.length > 0;

  const successRate = metrics && metrics.totalRuns > 0
    ? Math.round((metrics.successCount / metrics.totalRuns) * 100)
    : null;

  const dailyChartData = useMemo(() => {
    if (!metrics?.daily?.length) return [];
    const byDay = new Map(metrics.daily.map((d) => [d.day, d]));
    const days: Array<{ day: string; label: string; completed: number; failed: number }> = [];
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
          <div className="mt-1 max-w-sm text-sm">Use jobs for recurring maintenance, scheduled checks, and repeatable agent workflows that should run without manual prompting.</div>
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
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* Stats + Chart row */}
        {metrics && metrics.totalRuns > 0 && (
          <>
            <div className="flex flex-wrap gap-2 sm:gap-3">
              <StatCard label="Total Runs" value={metrics.totalRuns} sub="Last 7 days" />
              <StatCard
                label="Success Rate"
                value={successRate !== null ? `${successRate}%` : "-"}
                sub="Last 7 days"
                variant={successRate !== null && successRate < 80 ? "warning" : undefined}
              />
              <StatCard
                label="Avg Duration"
                value={metrics.avgDurationMs ? formatDuration(metrics.avgDurationMs) : "-"}
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
                  <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Daily Runs</h3>
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
                  <span className="font-medium text-foreground">{job.name}</span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{formatTimeUntil(job.nextRun!)}</span>
                    <span className="hidden text-muted-foreground/60 sm:inline">{formatTimeUntilDate(job.nextRun!)}</span>
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
              {recentRuns.filter((run) => jobs.some((j) => j.id === run.jobId)).slice(0, 8).map((run) => {
                return (
                  <button
                    key={run.id}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/50"
                    onClick={() => onSelectRun(run.jobId, run.id)}
                  >
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">{run.jobName}</span>
                    <span className={cn("shrink-0 text-xs capitalize", statusTextColor(run.status))}>{run.status}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatDuration(run.durationMs)}</span>
                    <span className="shrink-0 text-xs text-muted-foreground/60">{formatRelativeTime(run.startedAt)}</span>
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

const dailyRunsChartConfig = {
  completed: { label: "Completed", color: "hsl(var(--chart-1))" },
  failed: { label: "Failed", color: "hsl(var(--status-blocked))" },
} satisfies ChartConfig;

function DailyRunsChart({ data }: { data: Array<{ day: string; label: string; completed: number; failed: number }> }) {
  return (
    <ChartContainer config={dailyRunsChartConfig} className="h-full w-full">
      <BarChart data={data} barCategoryGap="20%">
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={6} tick={{ fontSize: 11 }} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              indicator="dot"
              formatter={(value, name, item) => (
                <>
                  <div className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: item.color }} />
                  <div className="flex flex-1 items-center justify-between gap-4">
                    <span className="text-muted-foreground">{dailyRunsChartConfig[name as keyof typeof dailyRunsChartConfig]?.label ?? name}</span>
                    <span className="font-mono font-medium tabular-nums text-foreground">{value as number}</span>
                  </div>
                </>
              )}
              labelFormatter={(label) => label as string}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent className="gap-2" />} />
        <Bar dataKey="completed" stackId="runs" fill="var(--color-completed)" radius={0} />
        <Bar dataKey="failed" stackId="runs" fill="var(--color-failed)" radius={[2, 2, 0, 0]} />
      </BarChart>
    </ChartContainer>
  );
}

// ─── Avg Duration Per Job ─────────────────────────────────────────────

function JobAvgDuration({ runs }: {
  runs: Array<{ jobName: string; durationMs: number | null }>;
}) {
  const perJob = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const run of runs) {
      if (run.durationMs == null) continue;
      if (!map.has(run.jobName)) map.set(run.jobName, []);
      map.get(run.jobName)!.push(run.durationMs);
    }
    const result = [...map.entries()].map(([name, durations]) => ({
      name,
      avg: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length),
      runs: durations.length,
    }));
    const maxAvg = Math.max(...result.map((j) => j.avg), 1);
    return { jobs: result, maxAvg };
  }, [runs]);

  if (perJob.jobs.length === 0) return null;

  return (
    <div>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Avg Duration</h3>
      <div className="h-[180px] sm:h-[220px] rounded-md border border-border bg-muted/40 p-3 flex flex-col justify-center">
        <div className="flex flex-col gap-3 overflow-y-auto min-h-0">
        {perJob.jobs.map((job) => (
          <div key={job.name}>
            <div className="mb-1 flex items-center justify-between">
              <span className="truncate text-xs text-muted-foreground">{job.name}</span>
              <span className="text-xs font-medium tabular-nums text-foreground">{formatDuration(job.avg)}</span>
            </div>
            <div className="flex h-2 overflow-hidden rounded-sm bg-muted/60">
              <div className="bg-chart-1/70 transition-all rounded-sm" style={{ width: `${(job.avg / perJob.maxAvg) * 100}%` }} />
            </div>
          </div>
        ))}
        </div>
      </div>
    </div>
  );
}

// ─── Run History Grid ────────────────────────────────────────────────

const MAX_RUN_CELLS = 16;

function RunHistoryGrid({ runs }: {
  runs: Array<{ jobId: string; jobName: string; status: JobRunStatus; startedAt: string }>;
}) {
  const perJob = useMemo(() => {
    const grouped = new Map<string, Array<{ status: JobRunStatus; startedAt: string }>>();
    for (const run of runs) {
      if (!grouped.has(run.jobName)) grouped.set(run.jobName, []);
      grouped.get(run.jobName)!.push({ status: run.status, startedAt: run.startedAt });
    }
    // Each job's runs are newest-first from the API; take last N then reverse to oldest→newest
    const result: Array<{ name: string; runs: Array<{ status: JobRunStatus; startedAt: string }> }> = [];
    for (const [name, jobRuns] of grouped) {
      result.push({ name, runs: jobRuns.slice(0, MAX_RUN_CELLS).reverse() });
    }
    return result;
  }, [runs]);

  if (perJob.length === 0) return null;

  return (
    <div>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Run History</h3>
      <div className="h-[180px] sm:h-[220px] rounded-md border border-border bg-muted/40 p-3 flex flex-col justify-between">
        <TooltipProvider delayDuration={80}>
          <div className="space-y-2 overflow-y-auto min-h-0 flex-1">
            {perJob.map(({ name, runs: jobRuns }) => (
              <div key={name}>
                <div className="mb-1 truncate text-[10px] text-muted-foreground">{name}</div>
                <div className="grid gap-[1px]" style={{ gridTemplateColumns: `repeat(${MAX_RUN_CELLS}, 1fr)` }}>
                  {Array.from({ length: MAX_RUN_CELLS }, (_, i) => {
                    const run = i < jobRuns.length ? jobRuns[i] : null;
                    if (!run) return <div key={i} className="h-4 sm:h-3 bg-muted/30" />;
                    return (
                      <Tooltip key={i}>
                        <TooltipTrigger asChild>
                          <div className={cn(
                            "h-4 sm:h-3",
                            run.status === "completed" && "bg-status-done/70",
                            (run.status === "failed" || run.status === "timed_out" || run.status === "crashed") && "bg-status-blocked/70",
                            (run.status === "running" || run.status === "started") && "bg-status-working/70",
                            run.status === "needs_input" && "bg-status-waiting/70",
                          )} />
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">
                          {run.status} — {formatRelativeTime(run.startedAt)}
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </TooltipProvider>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-3 bg-status-done/70" />Completed</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-3 bg-status-blocked/70" />Failed</span>
        </div>
      </div>
    </div>
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
          <DialogPrimitive.Description className="sr-only">Create a new recurring Dispatch job.</DialogPrimitive.Description>
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
  onAddJob,
  isAdding,
  enabledAgentTypes,
}: {
  onAddJob: (job: AddJobConfig) => Promise<void>;
  isAdding: boolean;
  enabledAgentTypes: AgentType[];
}) {
  const [displayName, setDisplayName] = useState("");
  const [directory, setDirectory] = useState("");
  const [prompt, setPrompt] = useState("");
  const [schedule, setSchedule] = useState("");
  const [timeoutMinutes, setTimeoutMinutes] = useState("30");
  const [needsInputTimeoutMinutes, setNeedsInputTimeoutMinutes] = useState("1440");
  const [agentType, setAgentType] = useState<AgentType>(enabledAgentTypes[0] ?? "codex");
  const [fullAccess, setFullAccess] = useState(false);
  const [useWorktree, setUseWorktree] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [enableImmediately, setEnableImmediately] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const scheduleError = cronError(schedule, enableImmediately);
  const canAdd = !!displayName.trim() && !!directory.trim() && !!prompt.trim() && !scheduleError && !!msFromMinutes(timeoutMinutes) && !!msFromMinutes(needsInputTimeoutMinutes);

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col overflow-hidden p-4 md:p-8">
      <div className="text-lg font-semibold">Create a new job</div>
      <p className="mt-1 text-sm text-muted-foreground">Define a recurring automation with a prompt and schedule.</p>

      <ScrollArea className="mt-6 min-h-0 flex-1 pr-1">
        <div className="grid min-w-0 gap-4">
          <div className="min-w-0 rounded-md border border-border bg-background/50 p-4">
            <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-sm">
              <span>
                <span className="block font-medium text-foreground">Enabled</span>
                <span className="block text-xs text-muted-foreground">Run this job on its schedule after creating it.</span>
              </span>
              <SwitchToggle checked={enableImmediately} onCheckedChange={setEnableImmediately} ariaLabel="Enable job" />
            </label>
            <div className="mt-4 grid min-w-0 gap-3 md:grid-cols-2">
              <div className="min-w-0 space-y-1 md:col-span-2">
                <label className="text-sm text-muted-foreground" htmlFor="job-display-name">Name</label>
                <Input id="job-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="e.g. Daily cleanup" />
              </div>
              <div className="min-w-0 space-y-1 md:col-span-2">
                <label className="text-sm text-muted-foreground" htmlFor="job-directory">Working directory</label>
                <PathInput
                  value={directory}
                  onChange={setDirectory}
                  label=""
                  placeholder="~/code/project"
                  id="job-directory"
                  data-testid="job-directory-input"
                />
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

          <div className="min-w-0 rounded-md border border-border bg-muted/20 p-4">
            <div className="space-y-1">
              <label className="text-sm font-medium text-foreground" htmlFor="job-prompt">Prompt</label>
              <p className="text-xs text-muted-foreground">The instructions the agent will follow when this job runs.</p>
            </div>
            <textarea
              id="job-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Describe what the agent should do..."
              className="mt-2 min-h-32 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          <div className="min-w-0 rounded-md border border-border bg-background/50 p-4">
            <button type="button" className="flex w-full items-center justify-between gap-3 text-left" onClick={() => setAdvancedOpen((current) => !current)}>
              <div>
                <div className="text-sm font-medium">Advanced settings</div>
                <div className="mt-1 text-xs text-muted-foreground">Timeouts, worktree behavior, and permissions.</div>
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

          {submitError ? (
            <div className="rounded-md border border-status-blocked/40 bg-status-blocked/10 p-3 text-sm text-status-blocked">{submitError}</div>
          ) : null}
        </div>
      </ScrollArea>

      <div className="mt-4 flex shrink-0 justify-end gap-2 border-t border-border/70 pt-4">
        <Button
          variant="primary"
          disabled={!canAdd || isAdding}
          onClick={() => {
            setSubmitError(null);
            void onAddJob({
              name: displayName.trim(),
              directory: directory.trim(),
              displayName: displayName.trim(),
              prompt: prompt.trim(),
              schedule: schedule.trim() || null,
              timeoutMs: msFromMinutes(timeoutMinutes),
              needsInputTimeoutMs: msFromMinutes(needsInputTimeoutMinutes),
              agentType,
              useWorktree,
              branchName: useWorktree ? branchName : null,
              fullAccess,
              enabled: enableImmediately,
            }).catch((error) => setSubmitError(errorMessage(error)));
          }}
        >
          {isAdding ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Add job
        </Button>
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
          <div className="mt-1 truncate font-mono text-xs text-muted-foreground" title={job.directory}>{shortPath(job.directory)}</div>
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
          <HistoryTab runs={history} loading={historyLoading} selectedRunId={selectedRunId} onSelectRun={onSelectRun} />
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
                name: job.name,
                directory: job.directory,
                displayName,
                schedule: schedule.trim() || null,
                timeoutMs: msFromMinutes(timeoutMinutes),
                needsInputTimeoutMs: msFromMinutes(needsInputTimeoutMinutes),
                agentType,
                useWorktree,
                branchName: useWorktree ? branchName : null,
                fullAccess,
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
          Remove this saved job, schedule, and run history from this Dispatch instance.
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
            Remove <span className="font-medium text-foreground">{job.name}</span> from this Dispatch instance? This removes its saved schedule and run history.
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
  const [prompt, setPrompt] = useState(job.prompt ?? "");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setPrompt(job.prompt ?? "");
    setSaveError(null);
    setSaved(false);
  }, [job]);

  return (
    <div className="mt-4 grid gap-4">
      <div className="rounded-md border border-border bg-background/50 p-4">
        <div className="space-y-1">
          <label className="text-sm font-medium text-foreground" htmlFor={`prompt-${job.id}`}>Prompt</label>
          <p className="text-xs text-muted-foreground">The instructions the agent will follow when this job runs.</p>
        </div>
        <textarea
          id={`prompt-${job.id}`}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe what the agent should do..."
          className="mt-2 min-h-44 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {saveError ? <div className="mt-4 rounded-md border border-status-blocked/40 bg-status-blocked/10 p-3 text-sm text-status-blocked">{saveError}</div> : null}
        {saved ? <div className="mt-4 rounded-md border border-status-done/40 bg-status-done/10 p-3 text-sm text-status-done">Prompt saved.</div> : null}
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
              }).then(() => {
                setSaved(true);
              }).catch((error) => {
                setSaveError(errorMessage(error));
              });
            }}
          >
            {isUpdating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save prompt
          </Button>
        </div>
      </div>
    </div>
  );
}

function HistoryTab({ runs, loading, selectedRunId, onSelectRun }: { runs: JobRun[]; loading: boolean; selectedRunId: string | null; onSelectRun: (runId: string) => void }) {
  const selectedRun = selectedRunId ? runs.find((run) => run.id === selectedRunId) ?? null : null;
  return (
    <ScrollArea className="mt-4 min-h-0 h-full pr-1">
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading history...</div>
      ) : runs.length === 0 ? (
        <div className="text-sm text-muted-foreground">No runs yet.</div>
      ) : (
        <div className="flex flex-col">
          {runs.map((run) => {
            const isSelected = selectedRun?.id === run.id;
            const isActive = run.status === "started" || run.status === "running" || run.status === "needs_input";
            return (
              <div key={run.id}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2.5 overflow-hidden py-1.5 text-left text-xs transition-colors hover:text-foreground",
                    isSelected ? "text-foreground" : "text-muted-foreground",
                  )}
                  onClick={() => onSelectRun(isSelected ? "" : run.id)}
                >
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", statusDotColor(run.status), isActive && "animate-pulse")} />
                  <span className={cn("shrink-0 font-medium", statusTextColor(run.status))}>{run.status}</span>
                  <span className="min-w-0 truncate font-mono tabular-nums">{formatDate(run.startedAt)}</span>
                  <span className="font-mono tabular-nums opacity-50">{formatDuration(run.durationMs)}</span>
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
    return <div className="mb-2 ml-4 border-l-2 border-border pl-3 text-xs text-muted-foreground">Select a run.</div>;
  }
  return (
    <div className="mb-2 ml-[3px] border-l-2 border-border pl-4">
      {run.report?.summary && (
        <div className="pb-1 text-xs text-muted-foreground">{run.report.summary}</div>
      )}
      {run.report?.tasks.map((task, index) => (
        <div key={`${task.name}-${index}`} className="py-0.5">
          <div className="flex items-center gap-1.5 text-xs">
            <span className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              task.status === "success" ? "bg-status-done" : task.status === "error" ? "bg-status-blocked" : "bg-muted-foreground",
            )} />
            <span className="font-medium">{task.name}</span>
            {task.status === "error" && <span className="uppercase text-status-blocked">{task.status}</span>}
          </div>
          {task.summary ? <div className="pl-3.5 text-xs text-muted-foreground/70">{task.summary}</div> : null}
          {task.errors?.map((error, errorIndex) => (
            <div key={errorIndex} className="pl-3.5 text-xs text-status-blocked">
              {error.message}
              {error.action ? <span className="ml-2 text-muted-foreground">{error.action}</span> : null}
            </div>
          ))}
          {task.logs?.slice(-5).map((log, logIndex) => (
            <div key={logIndex} className="pl-3.5 font-mono text-[11px] text-muted-foreground/50">[{log.level}] {log.message}</div>
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
        <div className="pt-1 font-mono text-[11px] text-muted-foreground/50">Completed {formatDate(run.completedAt)}</div>
      )}
      {!run.report && !run.pendingQuestion && (
        <div className="text-xs text-muted-foreground">No report yet.</div>
      )}
    </div>
  );
}
