// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";
import type { Job, JobRun } from "@/hooks/use-jobs";

import { JobDetailPane } from "./jobs-detail-pane";

// jobs-detail-pane.tsx owns wiring, not markup: it turns jobs-context state
// into the URLs JobDetail's tab/run-history callbacks navigate to, and it
// derives the run-blocked reason and the just-added banner copy from job
// fields. Every real child (JobsOverview, HistoryTab, SettingsTab, PromptTab)
// is replaced by a marker that records the props it received and exposes a
// button to invoke any callback prop, so what's under test is only the
// wiring jobs-detail-pane.tsx itself contributes.
const { H, record, stubModule } = vi.hoisted(() => {
  const props = new Map<string, Record<string, unknown>>();
  const record = (name: string, received: Record<string, unknown>) => {
    props.set(name, received);
  };
  const H = {
    props,
    clearProps: () => props.clear(),
    context: {} as Record<string, unknown>,
  };
  const stubModule = (name: string) => async () => {
    const React = await import("react");
    return {
      [name]: (received: Record<string, unknown>) => {
        record(name, received);
        return React.createElement("div", { "data-testid": `stub-${name}` });
      },
    };
  };
  return { H, record, stubModule };
});

vi.mock("@/components/app/jobs-context", () => ({
  useJobsContext: () => H.context,
}));
vi.mock("@/components/app/jobs-overview", stubModule("JobsOverview"));
vi.mock("@/components/app/jobs-settings-tab", stubModule("SettingsTab"));
vi.mock("@/components/app/jobs-prompt-tab", stubModule("PromptTab"));

vi.mock("@/components/app/jobs-history-tab", async () => {
  const React = await import("react");
  return {
    HistoryTab: (received: Record<string, unknown>) => {
      record("HistoryTab", received);
      const onSelectRun = received.onSelectRun as (runId: string) => void;
      return React.createElement(
        "div",
        { "data-testid": "stub-HistoryTab" },
        React.createElement("button", {
          "data-testid": "select-run",
          onClick: () => onSelectRun("run_9"),
        })
      );
    },
  };
});

type Mutation = { mutateAsync: ReturnType<typeof vi.fn>; isPending: boolean };

function mutationOf(name: "runNow" | "setEnabled"): Mutation {
  return H.context[name] as Mutation;
}

function propsOf(name: string): Record<string, unknown> {
  const received = H.props.get(name);
  expect(received, `${name} was never rendered`).toBeDefined();
  return received!;
}

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
    enabled: false,
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

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_1",
    name: "job-nightly-audit-abc123",
    status: "running",
    cwd: "/repo",
    worktreePath: null,
    worktreeBranch: null,
    tmuxSession: null,
    agentArgs: [],
    model: null,
    fullAccess: false,
    mediaDir: null,
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
    ...overrides,
  };
}

function defaultContext(job: Job | null): Record<string, unknown> {
  return {
    jobs: job ? [job] : [],
    selectedJob: job,
    tab: "configure",
    history: { data: { runs: [] as JobRun[] }, isLoading: false },
    attachedAgent: null,
    jobStats: { data: null, isLoading: false },
    routeRunId: undefined,
    navigate: vi.fn(),
    onOpenAgent: vi.fn().mockResolvedValue(undefined),
    enabledAgentTypes: ["claude"],
    runNow: {
      mutateAsync: vi.fn().mockResolvedValue(undefined),
      isPending: false,
    },
    setEnabled: {
      mutateAsync: vi.fn().mockResolvedValue(undefined),
      isPending: false,
    },
    updateJob: {
      mutateAsync: vi.fn().mockResolvedValue(undefined),
      isPending: false,
    },
    removeJob: {
      mutateAsync: vi.fn().mockResolvedValue(undefined),
      isPending: false,
    },
    justAddedJobId: null,
    setJustAddedJobId: vi.fn(),
    selectJob: vi.fn(),
  };
}

beforeEach(() => {
  H.clearProps();
});

afterEach(() => {
  cleanup();
});

describe("JobDetailPane — overview branch", () => {
  it("renders JobsOverview with stats coalesced to null and wires onSelectJob/onSelectRun", () => {
    const job = makeJob();
    H.context = defaultContext(null);
    H.context.jobs = [job];
    render(<JobDetailPane />);

    const overviewProps = propsOf("JobsOverview");
    expect(overviewProps.jobs).toEqual([job]);
    expect(overviewProps.stats).toBeNull();
    expect(overviewProps.statsLoading).toBe(false);

    (overviewProps.onSelectJob as (j: Job) => void)(job);
    expect(H.context.selectJob).toHaveBeenCalledWith(job);

    (overviewProps.onSelectRun as (jobId: string, runId: string) => void)(
      "job_1",
      "run_5"
    );
    expect(H.context.navigate).toHaveBeenCalledWith(
      "/automations/jobs/job_1/history/run_5"
    );
  });

  it("passes through non-null stats data", () => {
    H.context = defaultContext(null);
    H.context.jobStats = { data: { stats: {} }, isLoading: true };
    render(<JobDetailPane />);
    const overviewProps = propsOf("JobsOverview");
    expect(overviewProps.stats).toEqual({ stats: {} });
    expect(overviewProps.statsLoading).toBe(true);
  });
});

describe("JobDetailPane — tab navigation", () => {
  it("styles only the active tab button as active", () => {
    const job = makeJob();
    H.context = defaultContext(job);
    H.context.tab = "prompt";
    render(<JobDetailPane />);
    expect(screen.getByRole("button", { name: /prompt/i }).className).toContain(
      "border-primary"
    );
    expect(
      screen.getByRole("button", { name: /configure/i }).className
    ).not.toContain("border-primary");
  });

  it("navigates to the bare job URL for the configure tab and to a suffixed URL for others", () => {
    const job = makeJob();
    H.context = defaultContext(job);
    render(<JobDetailPane />);

    fireEvent.click(screen.getByRole("button", { name: /prompt/i }));
    expect(H.context.navigate).toHaveBeenLastCalledWith(
      "/automations/jobs/job_1/prompt"
    );

    fireEvent.click(screen.getByRole("button", { name: /history/i }));
    expect(H.context.navigate).toHaveBeenLastCalledWith(
      "/automations/jobs/job_1/history"
    );

    fireEvent.click(screen.getByRole("button", { name: /configure/i }));
    expect(H.context.navigate).toHaveBeenLastCalledWith(
      "/automations/jobs/job_1"
    );
  });

  it("selects a run via HistoryTab and clears the selection with a null runId", () => {
    const job = makeJob();
    H.context = defaultContext(job);
    H.context.tab = "history";
    render(<JobDetailPane />);

    fireEvent.click(screen.getByTestId("select-run"));
    expect(H.context.navigate).toHaveBeenCalledWith(
      "/automations/jobs/job_1/history/run_9"
    );

    const onSelectRun = propsOf("HistoryTab").onSelectRun as (
      runId: string | null
    ) => void;
    onSelectRun(null as unknown as string);
    expect(H.context.navigate).toHaveBeenLastCalledWith(
      "/automations/jobs/job_1/history"
    );
  });

  it("renders SettingsTab for configure and PromptTab for prompt", () => {
    const job = makeJob();
    H.context = defaultContext(job);
    H.context.tab = "prompt";
    render(<JobDetailPane />);
    expect(screen.getByTestId("stub-PromptTab")).toBeTruthy();
    expect(screen.queryByTestId("stub-SettingsTab")).toBeNull();
  });
});

describe("JobDetailPane — run-blocked reason", () => {
  it("blocks and explains when continuation is pending", () => {
    const job = makeJob({ continuationPending: true });
    H.context = defaultContext(job);
    render(<JobDetailPane />);
    expect(
      screen.getByText("The loop is preparing its next run.")
    ).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: /run now/i })
        .disabled
    ).toBe(true);
  });

  it("blocks and explains when a continuation run is already active", () => {
    const job = makeJob({
      continuationEnabled: true,
      lastRunStatus: "running",
    });
    H.context = defaultContext(job);
    render(<JobDetailPane />);
    expect(
      screen.getByText("This job already has a run in progress.")
    ).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: /run now/i })
        .disabled
    ).toBe(true);
  });

  it("does not block when continuation is enabled but no run is active", () => {
    const job = makeJob({
      continuationEnabled: true,
      lastRunStatus: "completed",
    });
    H.context = defaultContext(job);
    render(<JobDetailPane />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: /run now/i })
        .disabled
    ).toBe(false);
  });
});

describe("JobDetailPane — run now", () => {
  it("calls runNow.mutateAsync with the job on click", async () => {
    const job = makeJob();
    H.context = defaultContext(job);
    render(<JobDetailPane />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /run now/i }));
    });
    expect(mutationOf("runNow").mutateAsync).toHaveBeenCalledWith(job);
  });

  it("shows the error banner on failure even when the job was not just added", async () => {
    const job = makeJob();
    H.context = defaultContext(job);
    mutationOf("runNow").mutateAsync = vi
      .fn()
      .mockRejectedValue(new Error("boom"));
    render(<JobDetailPane />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /run now/i }));
    });
    expect(screen.getByText("boom")).toBeTruthy();
  });
});

describe("JobDetailPane — attached agent card", () => {
  it("shows the active-run copy and opens the session on click", async () => {
    const job = makeJob();
    const agent = makeAgent();
    H.context = defaultContext(job);
    H.context.attachedAgent = { agent, isActive: true };
    render(<JobDetailPane />);
    expect(
      screen.getByText("Active run is attached to a live agent session.")
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /open session/i }));
    });
    expect(H.context.onOpenAgent).toHaveBeenCalledWith(agent);
  });

  it("shows the kept-agent copy when the run is no longer active", () => {
    const job = makeJob();
    const agent = makeAgent({ status: "stopped" });
    H.context = defaultContext(job);
    H.context.attachedAgent = { agent, isActive: false };
    render(<JobDetailPane />);
    expect(
      screen.getByText(
        "Agent kept after completion — pick up where the run left off."
      )
    ).toBeTruthy();
  });
});

describe("JobDetailPane — just-added banner", () => {
  it("shows the scheduled-next-run copy when enabled with a nextRun", () => {
    const job = makeJob({ enabled: true, nextRun: "2026-08-28T12:00:00.000Z" });
    H.context = defaultContext(job);
    H.context.justAddedJobId = job.id;
    render(<JobDetailPane />);
    expect(screen.getByText(/Scheduled next run:/)).toBeTruthy();
  });

  it("shows the not-enabled-yet copy when a schedule exists but is disabled", () => {
    const job = makeJob({ enabled: false, schedule: "*/30 * * * *" });
    H.context = defaultContext(job);
    H.context.justAddedJobId = job.id;
    render(<JobDetailPane />);
    expect(
      screen.getByText("This job is saved but not enabled on a schedule yet.")
    ).toBeTruthy();
  });

  it("requires BOTH enabled and a nextRun for the scheduled-next-run copy, not either alone", () => {
    const job = makeJob({
      enabled: true,
      nextRun: null,
      schedule: "*/30 * * * *",
    });
    H.context = defaultContext(job);
    H.context.justAddedJobId = job.id;
    render(<JobDetailPane />);
    expect(screen.queryByText(/Scheduled next run:/)).toBeNull();
    expect(
      screen.getByText("This job is saved but not enabled on a schedule yet.")
    ).toBeTruthy();
  });

  it("shows the on-demand copy when there is no schedule", () => {
    const job = makeJob({ enabled: false, schedule: null });
    H.context = defaultContext(job);
    H.context.justAddedJobId = job.id;
    render(<JobDetailPane />);
    expect(
      screen.getByText("This job is on-demand — use Run now to start it.")
    ).toBeTruthy();
  });

  it("labels the enable button 'Enable job' when continuation is enabled and wires it to setEnabled", async () => {
    const job = makeJob({
      enabled: false,
      schedule: null,
      continuationEnabled: true,
    });
    H.context = defaultContext(job);
    H.context.justAddedJobId = job.id;
    render(<JobDetailPane />);
    const enableButton = screen.getByRole("button", { name: "Enable job" });
    await act(async () => {
      fireEvent.click(enableButton);
    });
    expect(mutationOf("setEnabled").mutateAsync).toHaveBeenCalledWith({
      job,
      enabled: true,
    });
  });

  it("labels the enable button 'Enable schedule' when continuation is off and enables it once a schedule exists", () => {
    const job = makeJob({
      enabled: false,
      schedule: null,
      continuationEnabled: false,
    });
    H.context = defaultContext(job);
    H.context.justAddedJobId = job.id;
    render(<JobDetailPane />);
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Enable schedule",
      }).disabled
    ).toBe(true);

    H.clearProps();
    H.context = defaultContext(makeJob({ ...job, schedule: "*/30 * * * *" }));
    H.context.justAddedJobId = job.id;
    cleanup();
    render(<JobDetailPane />);
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Enable schedule",
      }).disabled
    ).toBe(false);
  });

  it("hides the enable button once the job is already enabled", () => {
    const job = makeJob({ enabled: true, nextRun: null });
    H.context = defaultContext(job);
    H.context.justAddedJobId = job.id;
    render(<JobDetailPane />);
    expect(screen.queryByRole("button", { name: /enable/i })).toBeNull();
  });

  it("dismisses the banner and switches tabs from Edit settings / View history", () => {
    const job = makeJob();
    H.context = defaultContext(job);
    H.context.justAddedJobId = job.id;
    render(<JobDetailPane />);

    fireEvent.click(screen.getByRole("button", { name: /edit settings/i }));
    expect(H.context.setJustAddedJobId).toHaveBeenCalledWith(null);
    expect(H.context.navigate).toHaveBeenLastCalledWith(
      "/automations/jobs/job_1"
    );

    fireEvent.click(screen.getByRole("button", { name: /view history/i }));
    expect(H.context.navigate).toHaveBeenLastCalledWith(
      "/automations/jobs/job_1/history"
    );
  });

  it("does not render the banner when the selected job is not the just-added one", () => {
    const job = makeJob();
    H.context = defaultContext(job);
    H.context.justAddedJobId = "some_other_job";
    render(<JobDetailPane />);
    expect(screen.queryByText("Job added")).toBeNull();
  });
});

describe("JobDetailPane — status badge", () => {
  it("shows 'never run' when there is no last run status", () => {
    const job = makeJob({ lastRunStatus: null });
    H.context = defaultContext(job);
    render(<JobDetailPane />);
    expect(screen.getByText("never run")).toBeTruthy();
  });

  it("shows the raw status when a last run status exists", () => {
    const job = makeJob({ lastRunStatus: "completed" });
    H.context = defaultContext(job);
    render(<JobDetailPane />);
    expect(screen.getByText("completed")).toBeTruthy();
  });
});

describe("JobDetailPane — continuation status card", () => {
  it("is hidden when continuation is disabled", () => {
    const job = makeJob({ continuationEnabled: false });
    H.context = defaultContext(job);
    render(<JobDetailPane />);
    expect(screen.queryByText(/Loop/)).toBeNull();
  });

  it("shows 'Loop enabled' and 'No run limit.' with no prior run and no cap", () => {
    const job = makeJob({
      continuationEnabled: true,
      lastRunIteration: null,
      continuationPending: false,
      maxIterations: null,
    });
    H.context = defaultContext(job);
    render(<JobDetailPane />);
    expect(screen.getByText("Loop enabled")).toBeTruthy();
    expect(screen.getByText("No run limit.")).toBeTruthy();
  });

  it("shows the run count and the iteration cap once a run has happened", () => {
    const job = makeJob({
      continuationEnabled: true,
      lastRunIteration: 3,
      continuationPending: false,
      maxIterations: 5,
    });
    H.context = defaultContext(job);
    render(<JobDetailPane />);
    expect(screen.getByText("Loop • run 3")).toBeTruthy();
    expect(screen.getByText("Up to 5 runs.")).toBeTruthy();
  });

  it("shows the preparing-next-run copy while pending, ahead of the run-limit copy", () => {
    const job = makeJob({
      continuationEnabled: true,
      continuationPending: true,
      maxIterations: 5,
    });
    H.context = defaultContext(job);
    render(<JobDetailPane />);
    expect(screen.getByText("Preparing the next run.")).toBeTruthy();
    expect(screen.queryByText("Up to 5 runs.")).toBeNull();
  });
});

describe("JobDetailPane — SettingsTab/PromptTab wiring", () => {
  it("wires onUpdateJob to updateJob.mutateAsync and isUpdating through to both tabs", async () => {
    const job = makeJob();
    H.context = defaultContext(job);
    H.context.updateJob = {
      mutateAsync: vi.fn().mockResolvedValue(undefined),
      isPending: true,
    };
    render(<JobDetailPane />);

    const settingsProps = propsOf("SettingsTab");
    expect(settingsProps.isUpdating).toBe(true);
    await act(async () => {
      await (settingsProps.onUpdateJob as (j: Job) => Promise<void>)(job);
    });
    expect(
      (H.context.updateJob as { mutateAsync: ReturnType<typeof vi.fn> })
        .mutateAsync
    ).toHaveBeenCalledWith(job);
  });

  it("wires onRemoveJob to removeJob.mutateAsync and navigates to the jobs list on success", async () => {
    const job = makeJob();
    H.context = defaultContext(job);
    render(<JobDetailPane />);

    const settingsProps = propsOf("SettingsTab");
    expect(settingsProps.isRemoving).toBe(false);
    await act(async () => {
      await (settingsProps.onRemoveJob as (j: Job) => Promise<void>)(job);
    });
    expect(
      (H.context.removeJob as { mutateAsync: ReturnType<typeof vi.fn> })
        .mutateAsync
    ).toHaveBeenCalledWith(job);
    expect(H.context.navigate).toHaveBeenCalledWith("/automations/jobs");
  });

  it("passes job and isUpdating through to PromptTab", () => {
    const job = makeJob();
    H.context = defaultContext(job);
    H.context.tab = "prompt";
    H.context.updateJob = {
      mutateAsync: vi.fn().mockResolvedValue(undefined),
      isPending: true,
    };
    render(<JobDetailPane />);
    const promptProps = propsOf("PromptTab");
    expect(promptProps.job).toEqual(job);
    expect(promptProps.isUpdating).toBe(true);
  });
});
