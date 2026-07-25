// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";
import type { Job } from "@/hooks/use-jobs";

// The provider under test derives everything from the route and the useJobs
// hooks; only the hook seam is mocked so the derivation logic runs for real.
vi.mock("@/hooks/use-jobs", () => ({
  useJobs: vi.fn(),
  useJobActions: vi.fn(),
  useJobHistory: vi.fn(),
  useJobStats: vi.fn(),
}));

const { useJobs, useJobActions, useJobHistory, useJobStats } =
  await import("@/hooks/use-jobs");
const { JobsProvider, useJobsContext } = await import("./jobs-context");

const useJobsMock = vi.mocked(useJobs);
const useJobActionsMock = vi.mocked(useJobActions);
const useJobHistoryMock = vi.mocked(useJobHistory);
const useJobStatsMock = vi.mocked(useJobStats);

function makeJob(overrides: Partial<Job> = {}): Job {
  const base: Job = {
    id: "job_1",
    directory: "/repo",
    name: "nightly-audit",
    schedule: "0 3 * * *",
    timeoutMs: null,
    needsInputTimeoutMs: null,
    notify: null,
    prompt: null,
    enabled: true,
    agentType: "claude",
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
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    lastRunId: null,
    lastRunStatus: null,
    lastRunStartedAt: null,
    lastRunCompletedAt: null,
    lastRunDurationMs: null,
    lastRunReport: null,
    nextRun: null,
  };
  return { ...base, ...overrides };
}

function makeAgent(id: string, name: string): Agent {
  return {
    id,
    name,
    type: "claude",
    status: "running",
    cwd: "/repo",
    worktreePath: null,
    worktreeBranch: null,
    tmuxSession: `dispatch-${id}`,
    agentArgs: [],
    fullAccess: false,
    mediaDir: null,
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
  };
}

function Probe(): JSX.Element {
  const ctx = useJobsContext();
  const location = useLocation();
  return (
    <div>
      <div data-testid="selected-job">{ctx.selectedJob?.id ?? "none"}</div>
      <div data-testid="show-overview">{String(ctx.showOverview)}</div>
      <div data-testid="show-detail">{String(ctx.showDetailPane)}</div>
      <div data-testid="tab">{ctx.tab}</div>
      <div data-testid="route-run-id">{ctx.routeRunId ?? "none"}</div>
      <div data-testid="attached-agent">
        {ctx.attachedAgent
          ? `${ctx.attachedAgent.agent.name}:${ctx.attachedAgent.isActive}`
          : "none"}
      </div>
      <div data-testid="is-adding">{String(ctx.isAddingJob)}</div>
      <div data-testid="just-added">{ctx.justAddedJobId ?? "none"}</div>
      <div data-testid="location">{location.pathname}</div>
      <button onClick={() => ctx.selectJob(ctx.jobs[0]!)}>select-first</button>
      <button onClick={() => ctx.setJustAddedJobId("job_9")}>
        mark-just-added
      </button>
    </div>
  );
}

function renderProvider({
  path,
  jobs = [makeJob()],
  agents = [],
  open = true,
}: {
  path: string;
  jobs?: Job[];
  agents?: Agent[];
  open?: boolean;
}) {
  useJobsMock.mockReturnValue({
    data: jobs,
    isLoading: false,
    error: null,
  } as ReturnType<typeof useJobs>);
  useJobActionsMock.mockReturnValue({
    addJob: { mutateAsync: vi.fn(), isPending: false },
    runNow: { mutateAsync: vi.fn() },
    setEnabled: { mutateAsync: vi.fn() },
    updateJob: { mutateAsync: vi.fn() },
    removeJob: { mutateAsync: vi.fn() },
  } as unknown as ReturnType<typeof useJobActions>);
  useJobHistoryMock.mockReturnValue({
    data: undefined,
    isLoading: false,
  } as unknown as ReturnType<typeof useJobHistory>);
  useJobStatsMock.mockReturnValue({
    data: null,
    isLoading: false,
  } as unknown as ReturnType<typeof useJobStats>);

  const provider = (
    <JobsProvider
      open={open}
      agents={agents}
      onOpenAgent={vi.fn()}
      enabledAgentTypes={["claude"]}
    >
      <Probe />
    </JobsProvider>
  );
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/automations/jobs" element={provider} />
        <Route path="/automations/jobs/:jobId" element={provider} />
        <Route path="/automations/jobs/:jobId/:section" element={provider} />
        <Route
          path="/automations/jobs/:jobId/:section/:runId"
          element={provider}
        />
      </Routes>
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("JobsProvider route derivation", () => {
  it("treats the overview segment as overview, not a job id", () => {
    renderProvider({ path: "/automations/jobs/overview" });
    expect(screen.getByTestId("show-overview").textContent).toBe("true");
    expect(screen.getByTestId("selected-job").textContent).toBe("none");
    expect(screen.getByTestId("show-detail").textContent).toBe("true");
  });

  it("selects the job matching the route id and defaults to the configure tab", () => {
    renderProvider({ path: "/automations/jobs/job_1" });
    expect(screen.getByTestId("selected-job").textContent).toBe("job_1");
    expect(screen.getByTestId("show-detail").textContent).toBe("true");
    expect(screen.getByTestId("tab").textContent).toBe("configure");
  });

  it("shows no detail pane when the route id matches no job", () => {
    renderProvider({ path: "/automations/jobs/job_missing" });
    expect(screen.getByTestId("selected-job").textContent).toBe("none");
    expect(screen.getByTestId("show-detail").textContent).toBe("false");
  });

  it("shows no detail pane on the bare jobs route", () => {
    renderProvider({ path: "/automations/jobs" });
    expect(screen.getByTestId("show-overview").textContent).toBe("false");
    expect(screen.getByTestId("show-detail").textContent).toBe("false");
  });

  it("maps the prompt and history sections to their tabs", () => {
    renderProvider({ path: "/automations/jobs/job_1/prompt" });
    expect(screen.getByTestId("tab").textContent).toBe("prompt");
    cleanup();
    renderProvider({ path: "/automations/jobs/job_1/history" });
    expect(screen.getByTestId("tab").textContent).toBe("history");
  });

  it("falls back to configure for an unknown section", () => {
    renderProvider({ path: "/automations/jobs/job_1/bogus" });
    expect(screen.getByTestId("tab").textContent).toBe("configure");
  });

  it("exposes the run id from the route", () => {
    renderProvider({ path: "/automations/jobs/job_1/history/run_abc" });
    expect(screen.getByTestId("route-run-id").textContent).toBe("run_abc");
  });

  it("requests job stats only when open with no job selected", () => {
    renderProvider({ path: "/automations/jobs/job_1" });
    expect(useJobStatsMock).toHaveBeenLastCalledWith(false);
    cleanup();
    renderProvider({ path: "/automations/jobs/overview" });
    expect(useJobStatsMock).toHaveBeenLastCalledWith(true);
    cleanup();
    renderProvider({ path: "/automations/jobs/overview", open: false });
    expect(useJobStatsMock).toHaveBeenLastCalledWith(false);
    expect(useJobsMock).toHaveBeenLastCalledWith(false);
  });

  it("navigates to the job route and clears add state on selectJob", () => {
    renderProvider({ path: "/automations/jobs/overview" });
    fireEvent.click(screen.getByText("mark-just-added"));
    expect(screen.getByTestId("just-added").textContent).toBe("job_9");
    fireEvent.click(screen.getByText("select-first"));
    expect(screen.getByTestId("location").textContent).toBe(
      "/automations/jobs/job_1"
    );
    expect(screen.getByTestId("just-added").textContent).toBe("none");
    expect(screen.getByTestId("is-adding").textContent).toBe("false");
  });
});

describe("useAttachedJobAgent", () => {
  const runId = "44ced527-410b-48e3-a415-f9d585e8c620";

  it("returns null when the job has never run", () => {
    renderProvider({
      path: "/automations/jobs/job_1",
      jobs: [makeJob({ lastRunId: null, lastRunStatus: null })],
      agents: [makeAgent("agt_1", "job-nightly-audit-x")],
    });
    expect(screen.getByTestId("attached-agent").textContent).toBe("none");
  });

  it("matches a live run's agent by job-name prefix and marks it active", () => {
    renderProvider({
      path: "/automations/jobs/job_1",
      jobs: [makeJob({ lastRunId: runId, lastRunStatus: "running" })],
      agents: [
        makeAgent("agt_other", "unrelated"),
        makeAgent("agt_1", "job-nightly-audit-123"),
      ],
    });
    expect(screen.getByTestId("attached-agent").textContent).toBe(
      "job-nightly-audit-123:true"
    );
  });

  it("matches by run-id suffix when the name prefix differs", () => {
    renderProvider({
      path: "/automations/jobs/job_1",
      jobs: [makeJob({ lastRunId: runId, lastRunStatus: "needs_input" })],
      agents: [makeAgent("agt_1", `custom-name-${runId.slice(0, 8)}`)],
    });
    expect(screen.getByTestId("attached-agent").textContent).toBe(
      `custom-name-${runId.slice(0, 8)}:true`
    );
  });

  it("returns null for a finished run when the job auto-archives", () => {
    renderProvider({
      path: "/automations/jobs/job_1",
      jobs: [
        makeJob({
          lastRunId: runId,
          lastRunStatus: "completed",
          autoArchive: true,
        }),
      ],
      agents: [makeAgent("agt_1", "job-nightly-audit-123")],
    });
    expect(screen.getByTestId("attached-agent").textContent).toBe("none");
  });

  it("keeps a finished run's agent attached but inactive when auto-archive is off", () => {
    renderProvider({
      path: "/automations/jobs/job_1",
      jobs: [
        makeJob({
          lastRunId: runId,
          lastRunStatus: "completed",
          autoArchive: false,
        }),
      ],
      agents: [makeAgent("agt_1", "job-nightly-audit-123")],
    });
    expect(screen.getByTestId("attached-agent").textContent).toBe(
      "job-nightly-audit-123:false"
    );
  });

  it("returns null when no agent matches either heuristic", () => {
    renderProvider({
      path: "/automations/jobs/job_1",
      jobs: [makeJob({ lastRunId: runId, lastRunStatus: "running" })],
      agents: [makeAgent("agt_1", "job-other-job-999")],
    });
    expect(screen.getByTestId("attached-agent").textContent).toBe("none");
  });
});
