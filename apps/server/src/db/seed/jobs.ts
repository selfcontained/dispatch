import type { PoolClient } from "pg";

import { mulberry32, SEED_TAG, seedNow } from "./constants.js";

type SeedJob = {
  id: string;
  name: string;
  directory: string;
  schedule: string | null;
  timeoutMs: number;
  needsInputTimeoutMs: number;
  prompt: string;
  agentType: "claude" | "codex" | "opencode";
  useWorktree: boolean;
  branchName: string | null;
  fullAccess: boolean;
  runs: SeedJobRun[];
};

type SeedJobRun = {
  status: "completed" | "failed" | "timed_out" | "needs_input" | "crashed";
  daysAgo: number;
  durationMs: number;
  summary: string;
  pendingQuestion?: string;
};

const DEMO_DIR = "/tmp/dispatch-demo";
const IOS_DIR = "/tmp/ios-client-demo";
const SITE_DIR = "/tmp/marketing-site-demo";

const JOBS: SeedJob[] = [
  {
    id: "seed-job-nightly-cleanup",
    name: "nightly dev cleanup",
    directory: DEMO_DIR,
    schedule: "0 3 * * *",
    timeoutMs: 10 * 60 * 1000,
    needsInputTimeoutMs: 5 * 60 * 1000,
    prompt:
      "Vacuum orphaned tmux sessions and stale worktrees. Report anything unexpected.",
    agentType: "codex",
    useWorktree: false,
    branchName: null,
    fullAccess: true,
    runs: buildRunSeries("nightly", [
      {
        status: "completed",
        daysAgo: 1,
        durationMs: 4 * 60 * 1000,
        summary: "2 orphans cleaned",
      },
      {
        status: "completed",
        daysAgo: 2,
        durationMs: 3 * 60 * 1000,
        summary: "clean run",
      },
      {
        status: "failed",
        daysAgo: 3,
        durationMs: 60 * 1000,
        summary: "lost DB connection",
      },
      {
        status: "completed",
        daysAgo: 4,
        durationMs: 3 * 60 * 1000,
        summary: "clean run",
      },
      {
        status: "completed",
        daysAgo: 5,
        durationMs: 5 * 60 * 1000,
        summary: "1 worktree rebased",
      },
      {
        status: "completed",
        daysAgo: 6,
        durationMs: 3 * 60 * 1000,
        summary: "clean run",
      },
    ]),
  },
  {
    id: "seed-job-hourly-health",
    name: "api health probe",
    directory: DEMO_DIR,
    schedule: "0 * * * *",
    timeoutMs: 2 * 60 * 1000,
    needsInputTimeoutMs: 60 * 1000,
    prompt: "Hit /api/v1/health and verify the response. Alert if unhealthy.",
    agentType: "claude",
    useWorktree: false,
    branchName: null,
    fullAccess: false,
    runs: buildRunSeries("health", [
      {
        status: "completed",
        daysAgo: 0.04,
        durationMs: 12_000,
        summary: "healthy",
      },
      {
        status: "completed",
        daysAgo: 0.08,
        durationMs: 11_000,
        summary: "healthy",
      },
      {
        status: "timed_out",
        daysAgo: 0.12,
        durationMs: 2 * 60 * 1000,
        summary: "timed out waiting on DB",
      },
      {
        status: "completed",
        daysAgo: 0.17,
        durationMs: 10_000,
        summary: "healthy",
      },
      {
        status: "completed",
        daysAgo: 0.21,
        durationMs: 12_000,
        summary: "healthy",
      },
      {
        status: "completed",
        daysAgo: 0.25,
        durationMs: 11_000,
        summary: "healthy",
      },
      {
        status: "completed",
        daysAgo: 0.29,
        durationMs: 13_000,
        summary: "healthy",
      },
      {
        status: "completed",
        daysAgo: 0.33,
        durationMs: 10_000,
        summary: "healthy",
      },
    ]),
  },
  {
    id: "seed-job-weekly-deps",
    name: "weekly dep audit",
    directory: SITE_DIR,
    schedule: "0 9 * * 1",
    timeoutMs: 30 * 60 * 1000,
    needsInputTimeoutMs: 15 * 60 * 1000,
    prompt:
      "Check outdated dependencies and open PRs for low-risk patch upgrades.",
    agentType: "opencode",
    useWorktree: true,
    branchName: "deps/weekly-audit",
    fullAccess: false,
    runs: buildRunSeries("deps", [
      {
        status: "needs_input",
        daysAgo: 0.5,
        durationMs: 12 * 60 * 1000,
        summary: "paused — breaking change in framework major",
        pendingQuestion:
          "Upgrade to framework v5 now or pin to v4.x for another quarter?",
      },
      {
        status: "completed",
        daysAgo: 7,
        durationMs: 14 * 60 * 1000,
        summary: "3 patch PRs opened",
      },
      {
        status: "completed",
        daysAgo: 14,
        durationMs: 13 * 60 * 1000,
        summary: "2 patch PRs opened",
      },
    ]),
  },
  {
    id: "seed-job-ios-build",
    name: "ios nightly build",
    directory: IOS_DIR,
    schedule: "0 2 * * *",
    timeoutMs: 45 * 60 * 1000,
    needsInputTimeoutMs: 5 * 60 * 1000,
    prompt:
      "Build the iOS target on a clean simulator and run smoke tests. Upload logs.",
    agentType: "claude",
    useWorktree: true,
    branchName: "ci/nightly-ios",
    fullAccess: true,
    runs: buildRunSeries("ios", [
      {
        status: "completed",
        daysAgo: 1,
        durationMs: 18 * 60 * 1000,
        summary: "build + smoke pass",
      },
      {
        status: "failed",
        daysAgo: 2,
        durationMs: 6 * 60 * 1000,
        summary: "signing error",
      },
      {
        status: "completed",
        daysAgo: 3,
        durationMs: 19 * 60 * 1000,
        summary: "build + smoke pass",
      },
      {
        status: "crashed",
        daysAgo: 4,
        durationMs: 2 * 60 * 1000,
        summary: "simulator crashed during boot",
      },
    ]),
  },
  {
    id: "seed-job-release-notes",
    name: "release-notes drafter",
    directory: DEMO_DIR,
    schedule: null, // manually triggered only
    timeoutMs: 15 * 60 * 1000,
    needsInputTimeoutMs: 10 * 60 * 1000,
    prompt: "Summarize merged PRs since last tag into release-notes.md.",
    agentType: "claude",
    useWorktree: false,
    branchName: null,
    fullAccess: false,
    runs: buildRunSeries("relnotes", [
      {
        status: "completed",
        daysAgo: 14,
        durationMs: 4 * 60 * 1000,
        summary: "Draft saved",
      },
    ]),
  },
];

function buildRunSeries(
  tag: string,
  items: Array<Omit<SeedJobRun, never>>
): SeedJobRun[] {
  // Stable id namespace via tag — the index is suffixed in seedJobs.
  void tag;
  return items;
}

function daysAgo(now: Date, d: number): Date {
  return new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
}

function buildRunConfig(job: SeedJob): string {
  return JSON.stringify({
    directory: job.directory,
    name: job.name,
    schedule: job.schedule,
    timeoutMs: job.timeoutMs,
    needsInputTimeoutMs: job.needsInputTimeoutMs,
    notify: { onComplete: [], onError: [], onNeedsInput: [] },
    triggerSource: "scheduled",
    seed: SEED_TAG,
  });
}

function buildRunReport(run: SeedJobRun): string | null {
  if (run.status === "needs_input") return null;
  if (run.status === "crashed") return null;
  const reportStatus = run.status === "completed" ? "completed" : "failed";
  return JSON.stringify({
    status: reportStatus,
    summary: run.summary,
    tasks: [
      {
        name: "main",
        status: run.status === "completed" ? "success" : "error",
        summary: run.summary,
      },
    ],
  });
}

export async function seedJobs(client: PoolClient): Promise<void> {
  const now = seedNow();
  const rand = mulberry32(1234);
  let runCounter = 0;

  for (const job of JOBS) {
    await client.query(
      `
      INSERT INTO jobs (
        id, directory, name, schedule, timeout_ms, needs_input_timeout_ms,
        prompt, full_access, agent_type, use_worktree, branch_name, enabled,
        created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false, NOW() - INTERVAL '30 days', NOW())
      `,
      [
        job.id,
        job.directory,
        job.name,
        job.schedule,
        job.timeoutMs,
        job.needsInputTimeoutMs,
        job.prompt,
        job.fullAccess,
        job.agentType,
        job.useWorktree,
        job.branchName,
      ]
    );

    for (const run of job.runs) {
      const startedAt = daysAgo(now, run.daysAgo);
      const completedAt =
        run.status === "needs_input"
          ? null
          : new Date(startedAt.getTime() + run.durationMs);
      const runId = `seed-run-${job.id}-${runCounter++}-${Math.floor(rand() * 1e6)}`;
      await client.query(
        `
        INSERT INTO job_runs (
          id, job_id, agent_id, status, report, config, pending_question,
          started_at, status_updated_at, completed_at, duration_ms, created_at
        ) VALUES ($1,$2,NULL,$3,$4::jsonb,$5::jsonb,$6,$7,$7,$8,$9,$7)
        `,
        [
          runId,
          job.id,
          run.status,
          buildRunReport(run),
          buildRunConfig(job),
          run.pendingQuestion ?? null,
          startedAt,
          completedAt,
          run.status === "needs_input" ? null : run.durationMs,
        ]
      );
    }
  }
}
