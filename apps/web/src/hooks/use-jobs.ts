import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";

export type JobRunStatus = "started" | "running" | "completed" | "failed" | "needs_input" | "timed_out" | "crashed";
export type JobAgentType = "claude" | "codex" | "opencode";
export type JobRunTriggerSource = "manual" | "scheduled";

export type JobNotifyConfig = {
  onComplete: string[];
  onError: string[];
  onNeedsInput: string[];
};

export type JobReport = {
  status: "completed" | "failed" | "running";
  summary: string;
  tasks: Array<{
    name: string;
    status: "success" | "skipped" | "error";
    summary?: string;
    errors?: Array<{ message: string; recoverable?: boolean; action?: string }>;
    logs?: Array<{ level: "debug" | "info" | "warn" | "error"; message: string; timestamp: string }>;
  }>;
};

export type Job = {
  id: string;
  directory: string;
  name: string;
  filePath: string | null;
  schedule: string | null;
  timeoutMs: number | null;
  needsInputTimeoutMs: number | null;
  notify: JobNotifyConfig | null;
  prompt: string | null;
  enabled: boolean;
  agentType: JobAgentType;
  useWorktree: boolean;
  branchName: string | null;
  fullAccess: boolean;
  additionalInstructions: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunId: string | null;
  lastRunStatus: JobRunStatus | null;
  lastRunStartedAt: string | null;
  lastRunCompletedAt: string | null;
  lastRunDurationMs: number | null;
  lastRunReport: JobReport | null;
  nextRun: string | null;
};

export type JobRun = {
  id: string;
  jobId: string;
  agentId: string | null;
  status: JobRunStatus;
  report: JobReport | null;
  config: {
    directory: string;
    filePath: string;
    name: string;
    schedule: string | null;
    timeoutMs: number;
    needsInputTimeoutMs: number;
    notify: JobNotifyConfig;
    triggerSource?: JobRunTriggerSource;
  };
  pendingQuestion: string | null;
  startedAt: string;
  statusUpdatedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  createdAt: string;
};

export type CreateJobInput = {
  name: string;
  directory: string;
  prompt: string;
  schedule?: string | null;
  timeoutMs?: number;
  needsInputTimeoutMs?: number;
  agentType?: JobAgentType;
  useWorktree?: boolean;
  branchName?: string | null;
  fullAccess?: boolean;
  additionalInstructions?: string | null;
  enabled?: boolean;
};

export type UpdateJobInput = {
  id: string;
  name?: string;
  prompt?: string | null;
  schedule?: string | null;
  timeoutMs?: number;
  needsInputTimeoutMs?: number;
  agentType?: JobAgentType;
  useWorktree?: boolean;
  branchName?: string | null;
  fullAccess?: boolean;
  additionalInstructions?: string | null;
  enabled?: boolean;
};

export function useJobs(enabled = true) {
  return useQuery<Job[]>({
    queryKey: ["jobs"],
    queryFn: () => api<Job[]>("/api/v1/jobs"),
    enabled,
    refetchInterval: enabled ? 10_000 : false,
    refetchOnWindowFocus: false,
  });
}

export function useJobHistory(job: Job | null) {
  return useQuery<{ job: Omit<Job, "lastRunId" | "lastRunStatus" | "lastRunStartedAt" | "lastRunCompletedAt" | "lastRunDurationMs" | "lastRunReport" | "nextRun">; runs: JobRun[] }>({
    queryKey: ["jobs", job?.id, "history"],
    queryFn: () => {
      if (!job) throw new Error("Job is required.");
      const params = new URLSearchParams({ id: job.id, limit: "50" });
      return api(`/api/v1/jobs/history?${params.toString()}`);
    },
    enabled: !!job,
    refetchInterval: job ? 10_000 : false,
    refetchOnWindowFocus: false,
  });
}

export type JobStats = {
  stats: {
    totalRuns: number;
    successCount: number;
    failureCount: number;
    avgDurationMs: number | null;
    daily: Array<{ day: string; completed: number; failed: number }>;
  };
  recentRuns: Array<{ id: string; jobId: string; status: JobRunStatus; startedAt: string; durationMs: number | null; jobName: string }>;
};

export function useJobStats(enabled = true) {
  return useQuery<JobStats>({
    queryKey: ["jobs", "stats"],
    queryFn: () => api<JobStats>("/api/v1/jobs/stats"),
    enabled,
    refetchInterval: enabled ? 15_000 : false,
    refetchOnWindowFocus: false,
  });
}

export function useJobActions() {
  const queryClient = useQueryClient();
  const invalidateJobs = async () => {
    await queryClient.invalidateQueries({ queryKey: ["jobs"] });
  };

  const runNow = useMutation({
    mutationFn: (job: Pick<Job, "id">) =>
      api("/api/v1/jobs/run", {
        method: "POST",
        body: JSON.stringify({ id: job.id, wait: false }),
      }),
    onSuccess: invalidateJobs,
  });

  const createJob = useMutation({
    mutationFn: (input: CreateJobInput) =>
      api<Job>("/api/v1/jobs", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: invalidateJobs,
  });

  const updateJob = useMutation({
    mutationFn: (input: UpdateJobInput) =>
      api<Job>("/api/v1/jobs", {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    onSuccess: invalidateJobs,
  });

  const removeJob = useMutation({
    mutationFn: (job: Pick<Job, "id">) =>
      api<Job>("/api/v1/jobs", {
        method: "DELETE",
        body: JSON.stringify({ id: job.id }),
      }),
    onSuccess: invalidateJobs,
  });

  const setEnabled = useMutation({
    mutationFn: ({ job, enabled }: { job: Pick<Job, "id">; enabled: boolean }) =>
      api(`/api/v1/jobs/${enabled ? "enable" : "disable"}`, {
        method: "POST",
        body: JSON.stringify({ id: job.id }),
      }),
    onSuccess: invalidateJobs,
  });

  return { createJob, runNow, setEnabled, updateJob, removeJob };
}
