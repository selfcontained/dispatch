import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { JobReport } from "../../../server/src/jobs/report";
import type {
  AddJobInput,
  JobAgentType,
  JobNotifyConfig,
  JobRunRecord,
  JobRunStatus,
  JobWithLatestRun,
} from "../../../server/src/jobs/store";

export type { JobAgentType, JobNotifyConfig, JobReport, JobRunStatus };

export type JobRunTriggerSource = NonNullable<
  JobRunRecord["config"]["triggerSource"]
>;

export type Job = JobWithLatestRun & { nextRun: string | null };

export type JobRun = JobRunRecord;

export type AddJobConfig = AddJobInput;

export type RunJobResult = {
  jobId: string;
  runId: string;
  agentId: string;
  status: JobRunStatus;
  report: JobReport | null;
};

type JobIdentity = Pick<Job, "name" | "directory">;

export function useJobs(enabled = true) {
  return useQuery<Job[]>({
    queryKey: ["jobs"],
    queryFn: () => api<Job[]>("/api/v1/jobs"),
    enabled,
    refetchOnWindowFocus: false,
  });
}

export function useJobHistory(job: Job | null) {
  return useQuery<{
    job: Omit<
      Job,
      | "lastRunId"
      | "lastRunStatus"
      | "lastRunStartedAt"
      | "lastRunCompletedAt"
      | "lastRunDurationMs"
      | "lastRunReport"
      | "nextRun"
    >;
    runs: JobRun[];
  }>({
    queryKey: ["jobs", job?.directory, job?.name, "history"],
    queryFn: () => {
      if (!job) throw new Error("Job is required.");
      const params = new URLSearchParams({
        name: job.name,
        directory: job.directory,
        limit: "50",
      });
      return api(`/api/v1/jobs/history?${params.toString()}`);
    },
    enabled: !!job,
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
  recentRuns: Array<{
    id: string;
    jobId: string;
    status: JobRunStatus;
    startedAt: string;
    durationMs: number | null;
    jobName: string;
  }>;
};

export function useJobStats(enabled = true) {
  return useQuery<JobStats>({
    queryKey: ["jobs", "stats"],
    queryFn: () => api<JobStats>("/api/v1/jobs/stats"),
    enabled,
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
      api<RunJobResult>("/api/v1/jobs/run", {
        method: "POST",
        body: JSON.stringify({
          name: job.name,
          directory: job.directory,
          wait: false,
        }),
      }),
    onSuccess: invalidateJobs,
  });

  const addJob = useMutation({
    mutationFn: (job: AddJobConfig) =>
      api<Job>("/api/v1/jobs", {
        method: "POST",
        body: JSON.stringify(job),
      }),
    onSuccess: invalidateJobs,
  });

  const updateJob = useMutation({
    mutationFn: (job: AddJobConfig) =>
      api<Job>("/api/v1/jobs", {
        method: "PATCH",
        body: JSON.stringify(job),
      }),
    onSuccess: invalidateJobs,
  });

  const removeJob = useMutation({
    mutationFn: (job: JobIdentity) =>
      api<Job>("/api/v1/jobs", {
        method: "DELETE",
        body: JSON.stringify({ name: job.name, directory: job.directory }),
      }),
    onSuccess: invalidateJobs,
  });

  const setEnabled = useMutation({
    mutationFn: ({ job, enabled }: { job: JobIdentity; enabled: boolean }) =>
      api(`/api/v1/jobs/${enabled ? "enable" : "disable"}`, {
        method: "POST",
        body: JSON.stringify({ name: job.name, directory: job.directory }),
      }),
    onSuccess: invalidateJobs,
  });

  return { addJob, runNow, setEnabled, updateJob, removeJob };
}
