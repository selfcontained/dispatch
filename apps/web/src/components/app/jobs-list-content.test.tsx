// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Job } from "@/hooks/use-jobs";

import { JobListContent } from "./jobs-list-content";

// jobs-list-content.tsx owns the sidebar's row rendering and status/badge
// derivation, driven entirely by jobs-context state. Mock the context hook
// directly so each test controls exactly the branch under test.
const H = { context: {} as Record<string, unknown> };

vi.mock("@/components/app/jobs-context", () => ({
  useJobsContext: () => H.context,
}));

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_1",
    directory: "/repo",
    name: "nightly-audit",
    schedule: "*/30 * * * *",
    timeoutMs: 1_800_000,
    needsInputTimeoutMs: 86_400_000,
    notify: null,
    prompt: "Do the thing.",
    enabled: true,
    agentType: "claude",
    model: null,
    useWorktree: false,
    baseBranch: null,
    branchName: null,
    fullAccess: false,
    autoArchive: true,
    callable: false,
    singleton: true,
    webhookEnabled: false,
    webhookSecret: null,
    templateId: null,
    defaultArgs: {},
    selfImprove: false,
    continuationEnabled: false,
    maxIterations: null,
    completionCriteria: null,
    recoveryInstructions: null,
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
    lastRunId: null,
    lastRunStatus: null,
    lastRunStartedAt: null,
    lastRunCompletedAt: null,
    lastRunDurationMs: null,
    lastRunReport: null,
    continuationPending: false,
    lastRunChainId: null,
    lastRunIteration: null,
    nextRun: null,
    ...overrides,
  };
}

function defaultContext(jobs: Job[]): Record<string, unknown> {
  return {
    jobs,
    isLoading: false,
    error: null,
    selectedJob: null,
    showOverview: false,
    actionErrorByJobId: {} as Record<string, string>,
    selectJob: vi.fn(),
    openAddJob: vi.fn(),
    navigate: vi.fn(),
  };
}

beforeEach(() => {
  H.context = defaultContext([]);
});

afterEach(() => {
  cleanup();
});

describe("JobListContent — load states", () => {
  it("shows the error message from an Error instance", () => {
    H.context.error = new Error("network down");
    render(<JobListContent />);
    expect(screen.getByText("network down")).toBeTruthy();
  });

  it("falls back to a generic message for a non-Error error value", () => {
    H.context.error = "some string";
    render(<JobListContent />);
    expect(screen.getByText("Failed to load jobs.")).toBeTruthy();
  });

  it("shows a loading indicator before the error/empty checks when loading", () => {
    H.context.isLoading = true;
    render(<JobListContent />);
    expect(screen.getByText("Loading jobs...")).toBeTruthy();
  });

  it("prioritizes the error state over the loading state", () => {
    H.context.isLoading = true;
    H.context.error = new Error("network down");
    render(<JobListContent />);
    expect(screen.getByText("network down")).toBeTruthy();
    expect(screen.queryByText("Loading jobs...")).toBeNull();
  });

  it("shows the empty state when there are no jobs", () => {
    render(<JobListContent />);
    expect(screen.getByText("No jobs added yet.")).toBeTruthy();
  });
});

describe("JobListContent — overview row", () => {
  it("navigates to the overview and calls onItemSelect on click", () => {
    H.context = defaultContext([makeJob()]);
    const onItemSelect = vi.fn();
    render(<JobListContent onItemSelect={onItemSelect} />);
    fireEvent.click(screen.getByText("Overview"));
    expect(H.context.navigate).toHaveBeenCalledWith(
      "/automations/jobs/overview"
    );
    expect(onItemSelect).toHaveBeenCalledTimes(1);
  });

  it("does not throw when onItemSelect is omitted", () => {
    H.context = defaultContext([makeJob()]);
    render(<JobListContent />);
    expect(() => fireEvent.click(screen.getByText("Overview"))).not.toThrow();
  });

  it("marks the overview row active only when showOverview is true", () => {
    H.context = defaultContext([makeJob()]);
    H.context.showOverview = true;
    render(<JobListContent />);
    expect(screen.getByText("Overview").closest("button")!.className).toContain(
      "border-r-primary"
    );
  });

  it("does not mark the overview row active when showOverview is false", () => {
    H.context = defaultContext([makeJob()]);
    render(<JobListContent />);
    expect(
      screen.getByText("Overview").closest("button")!.className
    ).not.toContain("border-r-primary");
  });
});

describe("JobListContent — job rows", () => {
  it("selects the job and calls onItemSelect on click", () => {
    const job = makeJob();
    H.context = defaultContext([job]);
    const onItemSelect = vi.fn();
    render(<JobListContent onItemSelect={onItemSelect} />);
    fireEvent.click(screen.getByTestId(`job-row-${job.id}`));
    expect(H.context.selectJob).toHaveBeenCalledWith(job);
    expect(onItemSelect).toHaveBeenCalledTimes(1);
  });

  it("marks the row active only when it is the selected job", () => {
    const job = makeJob();
    const other = makeJob({ id: "job_2", name: "other" });
    H.context = defaultContext([job, other]);
    H.context.selectedJob = job;
    render(<JobListContent />);
    expect(screen.getByTestId(`job-row-${job.id}`).className).toContain(
      "md:border-r-primary"
    );
    expect(screen.getByTestId(`job-row-${other.id}`).className).not.toContain(
      "md:border-r-primary"
    );
  });

  it("shows 'new' for a job that has never run and the raw status otherwise", () => {
    const neverRun = makeJob({ id: "job_1", lastRunStatus: null });
    const ran = makeJob({ id: "job_2", lastRunStatus: "failed" });
    H.context = defaultContext([neverRun, ran]);
    render(<JobListContent />);
    expect(screen.getByTestId(`job-row-${neverRun.id}`).textContent).toContain(
      "new"
    );
    expect(screen.getByTestId(`job-row-${ran.id}`).textContent).toContain(
      "failed"
    );
  });

  it("shows the cron schedule and the enabled/disabled suffix that matches job.enabled", () => {
    const disabledJob = makeJob({
      id: "job_1",
      schedule: "*/30 * * * *",
      enabled: false,
    });
    const enabledJob = makeJob({
      id: "job_2",
      schedule: "0 * * * *",
      enabled: true,
    });
    H.context = defaultContext([disabledJob, enabledJob]);
    render(<JobListContent />);
    expect(screen.getByText("Cron: */30 * * * *")).toBeTruthy();
    expect(
      screen.getByTestId(`job-row-${disabledJob.id}`).textContent
    ).toContain("disabled");
    expect(
      screen.getByTestId(`job-row-${enabledJob.id}`).textContent
    ).toContain("enabled");
    // "enabled" must not appear on the disabled row, and vice versa — a
    // ternary swap otherwise still produces one match of each, just on the
    // wrong row.
    expect(
      screen.getByTestId(`job-row-${disabledJob.id}`).textContent
    ).not.toContain("enabled");
    expect(
      screen.getByTestId(`job-row-${enabledJob.id}`).textContent
    ).not.toContain("disabled");
  });

  it("shows 'On demand' with no enabled/disabled suffix when unscheduled", () => {
    const job = makeJob({ schedule: null });
    H.context = defaultContext([job]);
    render(<JobListContent />);
    expect(screen.getByText("On demand")).toBeTruthy();
    expect(screen.queryByText("enabled")).toBeNull();
    expect(screen.queryByText("disabled")).toBeNull();
  });

  it("shows loop-status text only when continuation is enabled, ranked pending > iteration > loop", () => {
    const pending = makeJob({
      id: "job_1",
      continuationEnabled: true,
      continuationPending: true,
      lastRunIteration: 3,
    });
    H.context = defaultContext([pending]);
    render(<JobListContent />);
    expect(screen.getByText("next run pending")).toBeTruthy();
    expect(screen.queryByText("run 3")).toBeNull();
  });

  it("shows the run count when not pending", () => {
    const job = makeJob({
      continuationEnabled: true,
      continuationPending: false,
      lastRunIteration: 3,
    });
    H.context = defaultContext([job]);
    render(<JobListContent />);
    expect(screen.getByText("run 3")).toBeTruthy();
  });

  it("shows 'loop' when continuation is enabled with no run yet", () => {
    const job = makeJob({
      continuationEnabled: true,
      continuationPending: false,
      lastRunIteration: null,
    });
    H.context = defaultContext([job]);
    render(<JobListContent />);
    expect(screen.getByText("loop")).toBeTruthy();
  });

  it("hides all loop-status text when continuation is disabled", () => {
    const job = makeJob({
      continuationEnabled: false,
      continuationPending: true,
      lastRunIteration: 3,
    });
    H.context = defaultContext([job]);
    render(<JobListContent />);
    expect(screen.queryByText("next run pending")).toBeNull();
    expect(screen.queryByText("run 3")).toBeNull();
    expect(screen.queryByText("loop")).toBeNull();
  });

  it("shows 'keeps agent' on the row with autoArchive off and not the other", () => {
    const kept = makeJob({ id: "job_1", autoArchive: false });
    const archived = makeJob({ id: "job_2", autoArchive: true });
    H.context = defaultContext([kept, archived]);
    render(<JobListContent />);
    expect(screen.getByTestId(`job-row-${kept.id}`).textContent).toContain(
      "keeps agent"
    );
    expect(
      screen.getByTestId(`job-row-${archived.id}`).textContent
    ).not.toContain("keeps agent");
  });

  it("shows 'callable' on the callable row and not the other", () => {
    const callable = makeJob({ id: "job_1", callable: true });
    const notCallable = makeJob({ id: "job_2", callable: false });
    H.context = defaultContext([callable, notCallable]);
    render(<JobListContent />);
    expect(screen.getByTestId(`job-row-${callable.id}`).textContent).toContain(
      "callable"
    );
    expect(
      screen.getByTestId(`job-row-${notCallable.id}`).textContent
    ).not.toContain("callable");
  });

  it("shows a per-job action error only for the job it belongs to", () => {
    const job1 = makeJob({ id: "job_1" });
    const job2 = makeJob({ id: "job_2", name: "second" });
    H.context = defaultContext([job1, job2]);
    H.context.actionErrorByJobId = { job_1: "run failed" };
    render(<JobListContent />);
    expect(screen.getByText("run failed")).toBeTruthy();
    expect(screen.getByTestId(`job-row-${job2.id}`).textContent).not.toContain(
      "run failed"
    );
  });
});

describe("JobListContent — header", () => {
  it("shows the compact header without a title when hideHeader is true", () => {
    H.context = defaultContext([]);
    render(<JobListContent hideHeader />);
    expect(screen.queryByText("Jobs")).toBeNull();
    fireEvent.click(screen.getByTestId("add-job-button"));
    expect(H.context.openAddJob).toHaveBeenCalledTimes(1);
  });

  it("shows the full header with a title when hideHeader is false", () => {
    H.context = defaultContext([]);
    render(<JobListContent />);
    expect(screen.getByText("Jobs")).toBeTruthy();
    fireEvent.click(screen.getByTestId("add-job-button"));
    expect(H.context.openAddJob).toHaveBeenCalledTimes(1);
  });
});
