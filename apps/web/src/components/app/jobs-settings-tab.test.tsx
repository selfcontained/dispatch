// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Job } from "@/hooks/use-jobs";

import { SettingsTab } from "./jobs-settings-tab";

// The tab renders its real children (jobs-form-fields, BranchSelect,
// AgentModelSelect) and the real model-catalog query; only the HTTP seam is
// mocked. The contract under test is the AddJobConfig each callback receives —
// form state -> payload — which a stubbed field tree could silently get wrong.
vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);

const MODEL_CATALOG = {
  models: {
    claude: [
      { id: "opus", label: "Opus" },
      { id: "sonnet", label: "Sonnet" },
    ],
    codex: [],
  },
};

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
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
    lastRunId: null,
    lastRunStatus: null,
    lastRunStartedAt: null,
    lastRunCompletedAt: null,
    lastRunDurationMs: null,
    lastRunReport: null,
    nextRun: null,
    ...overrides,
  };
}

// The payload SettingsTab builds from an untouched makeJob() form. Tests that
// flip one control assert against a single-field delta of this object so any
// accidental change to a neighboring field also fails.
function basePayload() {
  return {
    name: "nightly-audit",
    directory: "/repo",
    displayName: "nightly-audit",
    schedule: "*/30 * * * *",
    timeoutMs: 1_800_000,
    needsInputTimeoutMs: 86_400_000,
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
  };
}

function renderTab(job: Job) {
  const onUpdateJob = vi.fn().mockResolvedValue(undefined);
  const onRemoveJob = vi.fn().mockResolvedValue(undefined);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <SettingsTab
        job={job}
        enabledAgentTypes={["claude", "codex", "terminal"]}
        onUpdateJob={onUpdateJob}
        onRemoveJob={onRemoveJob}
        isUpdating={false}
        isRemoving={false}
      />
    </QueryClientProvider>
  );
  const rerenderJob = (nextJob: Job) =>
    view.rerender(
      <QueryClientProvider client={client}>
        <SettingsTab
          job={nextJob}
          enabledAgentTypes={["claude", "codex", "terminal"]}
          onUpdateJob={onUpdateJob}
          onRemoveJob={onRemoveJob}
          isUpdating={false}
          isRemoving={false}
        />
      </QueryClientProvider>
    );
  return { onUpdateJob, onRemoveJob, rerenderJob };
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
}

function nameInput(): HTMLInputElement {
  return screen.getByLabelText("Name") as HTMLInputElement;
}

function scheduleInput(): HTMLInputElement {
  return screen.getByLabelText(/Cron schedule/) as HTMLInputElement;
}

function enableSwitch(): HTMLButtonElement {
  return screen.getByRole("switch", {
    name: "Enable schedule",
  }) as HTMLButtonElement;
}

async function clickSave() {
  fireEvent.click(saveButton());
  // The click synchronously clears any prior "Settings saved." banner, so the
  // waitFor below always observes THIS save completing, not a stale one.
  expect(screen.queryByText("Settings saved.")).toBeNull();
  await waitFor(() => expect(screen.getByText("Settings saved.")).toBeTruthy());
}

beforeEach(() => {
  // Radix Select calls scrollIntoView when opening; jsdom has no layout.
  Element.prototype.scrollIntoView = vi.fn();
  apiMock.mockImplementation((path: string) => {
    if (path === "/api/v1/agent-models") return Promise.resolve(MODEL_CATALOG);
    return Promise.reject(new Error(`unexpected api call: ${path}`));
  });
});

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

describe("save payload", () => {
  it("sends the edited configuration with unit conversions applied", async () => {
    const { onUpdateJob } = renderTab(makeJob());

    fireEvent.change(nameInput(), { target: { value: "Renamed Job" } });
    fireEvent.change(scheduleInput(), { target: { value: "  0 12 * * 1  " } });
    fireEvent.change(screen.getByLabelText("Run timeout, minutes"), {
      target: { value: "45" },
    });
    fireEvent.change(screen.getByLabelText("Wait for input, minutes"), {
      target: { value: "10" },
    });

    await clickSave();
    expect(onUpdateJob).toHaveBeenCalledTimes(1);
    expect(onUpdateJob).toHaveBeenCalledWith({
      ...basePayload(),
      displayName: "Renamed Job",
      schedule: "0 12 * * 1",
      timeoutMs: 2_700_000,
      needsInputTimeoutMs: 600_000,
    });
  });

  it("clears an emptied schedule to null", async () => {
    const { onUpdateJob } = renderTab(makeJob());

    fireEvent.change(scheduleInput(), { target: { value: "   " } });

    await clickSave();
    expect(onUpdateJob).toHaveBeenCalledWith({
      ...basePayload(),
      schedule: null,
    });
  });

  it("normalizes a model id no longer in the catalog to null on save", async () => {
    const { onUpdateJob } = renderTab(makeJob({ model: "retired-model" }));

    // Wait for the catalog: while it loads, normalizeModel passes values
    // through untouched, so saving too early would sidestep the behavior
    // under test.
    await waitFor(() =>
      expect(screen.getByTestId("create-agent-model").textContent).toContain(
        "Default"
      )
    );

    await clickSave();
    expect(onUpdateJob).toHaveBeenCalledWith({ ...basePayload(), model: null });
  });

  it("passes worktree branches only while the worktree option is checked", async () => {
    const { onUpdateJob } = renderTab(
      makeJob({ useWorktree: true, baseBranch: "develop", branchName: "" })
    );

    fireEvent.change(screen.getByTestId("job-settings-job_1-worktree-branch"), {
      target: { value: "feat-y" },
    });
    await clickSave();
    expect(onUpdateJob).toHaveBeenLastCalledWith({
      ...basePayload(),
      useWorktree: true,
      baseBranch: "develop",
      branchName: "feat-y",
    });

    fireEvent.click(screen.getByTitle("Toggle git worktree"));
    await clickSave();
    expect(onUpdateJob).toHaveBeenLastCalledWith(basePayload());
  });

  it("inverts and forwards every advanced toggle", async () => {
    const { onUpdateJob } = renderTab(makeJob());

    fireEvent.click(screen.getByTitle("Toggle full access"));
    fireEvent.click(screen.getByTitle("Keep agent after run completes"));
    fireEvent.click(
      screen.getByRole("switch", { name: "Show in command palette" })
    );
    fireEvent.click(screen.getByRole("switch", { name: "Single instance" }));
    fireEvent.click(screen.getByRole("switch", { name: "Webhook trigger" }));

    await clickSave();
    expect(onUpdateJob).toHaveBeenCalledWith({
      ...basePayload(),
      fullAccess: true,
      // keepAgent checked must save as autoArchive: false — the inversion is
      // the whole point of the control.
      autoArchive: false,
      callable: true,
      singleton: false,
      webhookEnabled: true,
    });
  });

  it("shows the save error message when the update fails", async () => {
    const { onUpdateJob } = renderTab(makeJob());
    onUpdateJob.mockRejectedValueOnce(new Error("boom"));

    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByText("boom")).toBeTruthy());
    expect(screen.queryByText("Settings saved.")).toBeNull();
  });
});

describe("save gating", () => {
  it("disables Save when the name is emptied", () => {
    renderTab(makeJob());
    expect(saveButton().disabled).toBe(false);

    fireEvent.change(nameInput(), { target: { value: "   " } });
    expect(saveButton().disabled).toBe(true);
  });

  it("surfaces cron errors and blocks Save", () => {
    renderTab(makeJob());

    fireEvent.change(scheduleInput(), { target: { value: "* * *" } });

    expect(
      screen.getByText("Use a 5-field cron expression like */30 * * * *.")
    ).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it.each(["0", "abc"])("blocks Save on timeout input %j", (value) => {
    renderTab(makeJob());

    fireEvent.change(screen.getByLabelText("Run timeout, minutes"), {
      target: { value },
    });
    expect(saveButton().disabled).toBe(true);
  });
});

describe("schedule field", () => {
  it("humanizes the schedule and hides the field-level enable switch", () => {
    renderTab(makeJob());

    expect(screen.getByText("Every 30 minutes")).toBeTruthy();
    // The settings tab has its own top-level Enabled control; the schedule
    // field's inline switch (showEnabled) must stay hidden here.
    expect(screen.queryByRole("switch", { name: "Enable job" })).toBeNull();

    fireEvent.change(scheduleInput(), { target: { value: "" } });
    expect(screen.getByText("Leave blank for an on-demand job.")).toBeTruthy();
  });
});

describe("enabled toggle", () => {
  it("stays disabled until a schedule has been saved", () => {
    const { onUpdateJob } = renderTab(makeJob({ schedule: null }));

    expect(
      screen.getByText("Save a schedule before enabling this job.")
    ).toBeTruthy();
    expect(enableSwitch().disabled).toBe(true);
    fireEvent.click(enableSwitch());
    expect(onUpdateJob).not.toHaveBeenCalled();
  });

  it("optimistically enables and sends only the minimal payload", async () => {
    const { onUpdateJob } = renderTab(makeJob());

    fireEvent.click(enableSwitch());

    expect(enableSwitch().getAttribute("aria-checked")).toBe("true");
    expect(onUpdateJob).toHaveBeenCalledWith({
      name: "nightly-audit",
      directory: "/repo",
      enabled: true,
    });
    await waitFor(() => expect(enableSwitch().disabled).toBe(false));
  });

  it("reverts the toggle and shows the error when enabling fails", async () => {
    const { onUpdateJob } = renderTab(makeJob());
    onUpdateJob.mockRejectedValueOnce(new Error("scheduler offline"));

    fireEvent.click(enableSwitch());

    await waitFor(() =>
      expect(screen.getByText("scheduler offline")).toBeTruthy()
    );
    expect(enableSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("ignores further clicks while the update is in flight", async () => {
    const { onUpdateJob } = renderTab(makeJob());
    let resolveUpdate!: () => void;
    onUpdateJob.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveUpdate = resolve;
        })
    );

    fireEvent.click(enableSwitch());
    fireEvent.click(enableSwitch());

    expect(onUpdateJob).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveUpdate();
    });
  });
});

describe("job identity changes", () => {
  it("keeps unsaved edits across a refetch of the same job", () => {
    const { rerenderJob } = renderTab(makeJob());

    fireEvent.change(nameInput(), { target: { value: "my edit" } });
    // SSE-driven refetches produce a new object for the same job id with
    // volatile fields moved; that must not clobber the form.
    rerenderJob(
      makeJob({
        updatedAt: "2026-07-16T12:00:00.000Z",
        nextRun: "2026-07-16T13:00:00.000Z",
        lastRunStatus: "completed",
      })
    );

    expect(nameInput().value).toBe("my edit");
  });

  it("resets the form when a different job is selected", () => {
    const { rerenderJob } = renderTab(makeJob());

    fireEvent.change(nameInput(), { target: { value: "my edit" } });
    rerenderJob(
      makeJob({
        id: "job_2",
        name: "other-job",
        schedule: "0 9 * * *",
        enabled: true,
      })
    );

    expect(nameInput().value).toBe("other-job");
    expect(scheduleInput().value).toBe("0 9 * * *");
    // The enabled switch must track the newly selected job too — a stale
    // value here would render job_1's toggle state against job_2.
    expect(enableSwitch().getAttribute("aria-checked")).toBe("true");
  });
});

describe("agent type and model", () => {
  it("offers only CLI agent types and resets the model on change", async () => {
    const { onUpdateJob } = renderTab(makeJob({ model: "opus" }));

    // Wait for the catalog so the model select is showing the saved model.
    await waitFor(() =>
      expect(screen.getByTestId("create-agent-model").textContent).toContain(
        "Opus"
      )
    );

    const agentTypeTrigger = screen
      .getAllByRole("combobox")
      .find((element) => element.textContent?.includes("Claude"));
    if (!agentTypeTrigger) throw new Error("agent type trigger not found");
    fireEvent.click(agentTypeTrigger);

    const options = await screen.findAllByRole("option");
    const labels = options.map((option) => option.textContent);
    expect(labels).toContain("Claude");
    expect(labels).toContain("Codex");
    // Terminal agents have no CLI to drive — the field must filter them out.
    expect(labels).not.toContain("Terminal");

    fireEvent.click(screen.getByRole("option", { name: "Codex" }));

    await clickSave();
    expect(onUpdateJob).toHaveBeenCalledWith({
      ...basePayload(),
      agentType: "codex",
      // A model id belongs to one agent type; switching types must drop it.
      model: null,
    });
  });
});

describe("webhook section", () => {
  it("shows the secret URL when enabled with a saved secret", () => {
    renderTab(makeJob({ webhookEnabled: true, webhookSecret: "s3cret" }));

    const url = document.querySelector("code");
    expect(url?.textContent).toContain("/api/v1/jobs/webhook/s3cret");
  });

  it("prompts to save when enabling before a secret exists", () => {
    renderTab(makeJob());

    fireEvent.click(screen.getByRole("switch", { name: "Webhook trigger" }));

    expect(screen.getByText("Save to generate a webhook URL.")).toBeTruthy();
    expect(document.querySelector("code")).toBeNull();
  });
});

describe("remove flow", () => {
  it("requires confirmation and closes the dialog on success", async () => {
    const job = makeJob();
    const { onRemoveJob } = renderTab(job);

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByText("Remove job?")).toBeTruthy();
    expect(onRemoveJob).not.toHaveBeenCalled();

    const dialog = screen.getByRole("dialog");
    const confirm = Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Remove")
    );
    if (!confirm) throw new Error("confirm button not found");
    fireEvent.click(confirm);

    expect(onRemoveJob).toHaveBeenCalledWith(job);
    await waitFor(() => expect(screen.queryByText("Remove job?")).toBeNull());
  });

  it("keeps the dialog open and shows the error when removal fails", async () => {
    const { onRemoveJob } = renderTab(makeJob());
    onRemoveJob.mockRejectedValueOnce(new Error("job is mid-run"));

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = screen.getByRole("dialog");
    const confirm = Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Remove")
    );
    if (!confirm) throw new Error("confirm button not found");
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(screen.getByText("job is mid-run")).toBeTruthy()
    );
    expect(screen.getByText("Remove job?")).toBeTruthy();
  });
});
