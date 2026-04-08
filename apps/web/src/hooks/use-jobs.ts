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

export type AvailableJob = {
  name: string;
  fileStem: string;
  directory: string;
  filePath: string;
  schedule: string | null;
  timeoutMs: number;
  needsInputTimeoutMs: number;
  fullAccess: boolean;
  notify: JobNotifyConfig;
  prompt: string;
  promptPreview: string;
  alreadyConfigured: boolean;
  jobId: string | null;
};

export type AddJobConfig = {
  name: string;
  directory: string;
  displayName?: string;
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

export type AvailableJobsDirectory = {
  directory: string;
  source: "agent" | "manual";
  jobs: AvailableJob[];
  error: string | null;
};

type JobIdentity = Pick<Job, "name" | "directory">;

function fileStemFromPath(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const fileName = filePath.split("/").pop();
  return fileName?.endsWith(".md") ? fileName.slice(0, -3) : fileName ?? null;
}

function jobIdentity(job: JobIdentity & { filePath?: string | null }) {
  return { name: fileStemFromPath(job.filePath) ?? job.name, directory: job.directory };
}

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
    queryKey: ["jobs", job?.directory, job?.name, "history"],
    queryFn: () => {
      if (!job) throw new Error("Job is required.");
      const params = new URLSearchParams({ ...jobIdentity(job), limit: "50" });
      return api(`/api/v1/jobs/history?${params.toString()}`);
    },
    enabled: !!job,
    refetchInterval: job ? 10_000 : false,
    refetchOnWindowFocus: false,
  });
}

export function useAvailableJobs(enabled: boolean, directory?: string | null, forceKey = 0) {
  return useQuery<{ directories: AvailableJobsDirectory[] }>({
    queryKey: ["jobs", "available", directory?.trim() ?? "", forceKey],
    queryFn: () => {
      const params = new URLSearchParams();
      if (directory?.trim()) params.set("directory", directory.trim());
      if (forceKey > 0) params.set("force", "true");
      const query = params.toString();
      return api(`/api/v1/jobs/available${query ? `?${query}` : ""}`);
    },
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

export function useJobActions() {
  const queryClient = useQueryClient();
  const invalidateJobs = async () => {
    await queryClient.invalidateQueries({ queryKey: ["jobs"] });
  };

  const runNow = useMutation({
    mutationFn: (job: JobIdentity) =>
      api("/api/v1/jobs/run", {
        method: "POST",
        body: JSON.stringify({ ...jobIdentity(job), wait: false }),
      }),
    onSuccess: invalidateJobs,
  });

  const addJob = useMutation({
    mutationFn: (job: AddJobConfig) =>
      api<Job>("/api/v1/jobs", {
        method: "POST",
        body: JSON.stringify({
          ...job,
          ...jobIdentity(job),
        }),
      }),
    onSuccess: async () => {
      await invalidateJobs();
      await queryClient.invalidateQueries({ queryKey: ["jobs", "available"] });
    },
  });

  const updateJob = useMutation({
    mutationFn: (job: AddJobConfig) =>
      api<Job>("/api/v1/jobs", {
        method: "PATCH",
        body: JSON.stringify({
          ...job,
          ...jobIdentity(job),
        }),
      }),
    onSuccess: invalidateJobs,
  });

  const removeJob = useMutation({
    mutationFn: (job: JobIdentity) =>
      api<Job>("/api/v1/jobs", {
        method: "DELETE",
        body: JSON.stringify(jobIdentity(job)),
      }),
    onSuccess: async () => {
      await invalidateJobs();
      await queryClient.invalidateQueries({ queryKey: ["jobs", "available"] });
    },
  });

  const setEnabled = useMutation({
    mutationFn: ({ job, enabled }: { job: JobIdentity; enabled: boolean }) =>
      api(`/api/v1/jobs/${enabled ? "enable" : "disable"}`, {
        method: "POST",
        body: JSON.stringify(jobIdentity(job)),
      }),
    onSuccess: invalidateJobs,
  });

  return { addJob, runNow, setEnabled, updateJob, removeJob };
}
