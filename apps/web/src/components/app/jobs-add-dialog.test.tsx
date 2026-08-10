// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CWD_HISTORY_KEY,
  CWD_HISTORY_USAGE_KEY,
} from "./create-agent-dialog-utils";
import { AddJobDialog, AddJobFlow } from "./jobs-add-dialog";

// The flow renders its real children (jobs-form-fields, PathInput,
// AgentModelSelect) and the real cwd-history / model-catalog queries; only the
// HTTP seam is mocked. The contract under test is the AddJobConfig handed to
// onAddJob — form state -> payload — which a stubbed field tree could silently
// get wrong.
// Spread the real module so the file keeps working if a child ever imports
// api.ts's other exports (authEvents, UnauthenticatedError) — replacing the
// whole module would fail at eval time instead of at a useful assertion.
vi.mock("@/lib/api", async () => ({
  ...(await vi.importActual<typeof import("@/lib/api")>("@/lib/api")),
  api: vi.fn(),
}));

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);

const MODEL_CATALOG = {
  models: {
    claude: [
      { id: "opus", label: "Opus" },
      { id: "sonnet", label: "Sonnet" },
    ],
    codex: [{ id: "gpt-5.6-sol", label: "Sol" }],
  },
};

// The payload AddJobFlow builds once the three required fields are filled in
// and nothing else is touched. Tests that flip one control assert against a
// single-field delta of this object, so an accidental change to a neighboring
// field also fails.
function basePayload() {
  return {
    name: "Nightly audit",
    directory: "/repo",
    displayName: "Nightly audit",
    prompt: "Do the thing.",
    schedule: null,
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
    enabled: false,
    selfImprove: false,
  };
}

function renderFlow(
  options: { onAddJob?: ReturnType<typeof vi.fn>; isAdding?: boolean } = {}
) {
  const onAddJob = options.onAddJob ?? vi.fn().mockResolvedValue(undefined);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  // The flow's Cancel button is a Radix DialogClose, so it only renders inside
  // a Dialog root — mount the real AddJobDialog wrapper rather than a stand-in.
  render(
    <QueryClientProvider client={client}>
      <AddJobDialog open onOpenChange={() => {}}>
        <AddJobFlow
          onAddJob={onAddJob}
          isAdding={options.isAdding ?? false}
          enabledAgentTypes={["claude", "codex", "terminal"]}
        />
      </AddJobDialog>
    </QueryClientProvider>
  );
  return { onAddJob };
}

function addButton(): HTMLButtonElement {
  // While `isAdding` the button also renders ActivityBars, whose aria-label
  // prefixes the accessible name with "Loading". Anchoring the match to the
  // end keeps both states matching while still excluding the dialog's
  // "Close add job" button.
  return screen.getByRole("button", { name: /Add job$/ }) as HTMLButtonElement;
}

function scheduleInput(): HTMLInputElement {
  return screen.getByLabelText(/Cron schedule/) as HTMLInputElement;
}

/** Fill the three fields `canAdd` requires so the button is enabled. */
function fillRequiredFields({
  name = "Nightly audit",
  directory = "/repo",
  prompt = "Do the thing.",
}: { name?: string; directory?: string; prompt?: string } = {}) {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: name } });
  fireEvent.change(screen.getByTestId("job-directory-input"), {
    target: { value: directory },
  });
  fireEvent.change(screen.getByLabelText("Prompt"), {
    target: { value: prompt },
  });
}

/** Reveal the collapsed "Advanced settings" section. */
function openAdvanced() {
  fireEvent.click(screen.getByText("Advanced settings"));
}

// The advanced panel is always mounted and only collapsed via CSS plus
// aria-hidden, and jsdom applies no CSS. getByLabelText/getByTitle ignore
// aria-hidden, so they would find these controls while the section is still
// closed — making openAdvanced() inert and hiding a broken disclosure. Role
// queries honour aria-hidden, which keeps that expansion load-bearing.
function timeoutInput(): HTMLElement {
  return screen.getByRole("textbox", { name: "Run timeout, minutes" });
}

function needsInputTimeoutInput(): HTMLElement {
  return screen.getByRole("textbox", { name: "Wait for input, minutes" });
}

function advancedCheckbox(name: RegExp): HTMLElement {
  return screen.getByRole("checkbox", { name });
}

beforeEach(() => {
  // Radix Select calls scrollIntoView when opening; jsdom does not implement
  // it at all, so this has to be a raw assignment — vi.spyOn needs an existing
  // property. Reassigned every test, and each test file gets its own jsdom
  // environment, so it cannot leak.
  Element.prototype.scrollIntoView = vi.fn();
  window.localStorage.clear();
  apiMock.mockImplementation((path: string) => {
    if (path === "/api/v1/agent-models") return Promise.resolve(MODEL_CATALOG);
    if (path.startsWith("/api/v1/history/projects")) {
      return Promise.resolve({ projectOptions: [] });
    }
    if (path.startsWith("/api/v1/git/branches")) {
      return Promise.resolve({
        branches: ["main", "develop"],
        current: "main",
      });
    }
    return Promise.reject(new Error(`unexpected api call: ${path}`));
  });
});

afterEach(() => {
  cleanup();
  // Explicit: restoreAllMocks only undoes vi.spyOn spies, so a module-factory
  // mock's implementation and call history would otherwise leak forward.
  apiMock.mockReset();
  window.localStorage.clear();
});

describe("add payload", () => {
  it("sends the filled-in configuration with defaults and unit conversions", async () => {
    const { onAddJob } = renderFlow();

    // Trailing whitespace on every free-text field: the payload must carry the
    // trimmed values.
    fillRequiredFields({
      name: "  Nightly audit  ",
      directory: "  /repo  ",
      prompt: "  Do the thing.  ",
    });

    fireEvent.click(addButton());

    await waitFor(() => expect(onAddJob).toHaveBeenCalledTimes(1));
    expect(onAddJob).toHaveBeenCalledWith(basePayload());
  });

  it("converts the advanced timeout minutes to milliseconds", async () => {
    const { onAddJob } = renderFlow();
    fillRequiredFields();
    openAdvanced();

    fireEvent.change(timeoutInput(), {
      target: { value: "45" },
    });
    fireEvent.change(needsInputTimeoutInput(), {
      target: { value: "10" },
    });

    fireEvent.click(addButton());

    await waitFor(() => expect(onAddJob).toHaveBeenCalledTimes(1));
    expect(onAddJob).toHaveBeenCalledWith({
      ...basePayload(),
      timeoutMs: 2_700_000,
      needsInputTimeoutMs: 600_000,
    });
  });

  it("trims a whitespace-only schedule to null", async () => {
    const { onAddJob } = renderFlow();
    fillRequiredFields();

    fireEvent.change(scheduleInput(), { target: { value: "   " } });

    fireEvent.click(addButton());

    await waitFor(() => expect(onAddJob).toHaveBeenCalledTimes(1));
    expect(onAddJob).toHaveBeenCalledWith({ ...basePayload(), schedule: null });
  });

  it("sends a trimmed schedule when one is provided", async () => {
    const { onAddJob } = renderFlow();
    fillRequiredFields();

    fireEvent.change(scheduleInput(), { target: { value: "  0 12 * * 1  " } });

    fireEvent.click(addButton());

    await waitFor(() => expect(onAddJob).toHaveBeenCalledTimes(1));
    expect(onAddJob).toHaveBeenCalledWith({
      ...basePayload(),
      schedule: "0 12 * * 1",
    });
  });

  it("inverts the keep-agent option into autoArchive", async () => {
    const { onAddJob } = renderFlow();
    fillRequiredFields();
    openAdvanced();

    fireEvent.click(advancedCheckbox(/Keep agent after run completes/));

    fireEvent.click(addButton());

    await waitFor(() => expect(onAddJob).toHaveBeenCalledTimes(1));
    expect(onAddJob).toHaveBeenCalledWith({
      ...basePayload(),
      autoArchive: false,
    });
  });

  it("passes the remaining toggles straight through", async () => {
    const { onAddJob } = renderFlow();
    fillRequiredFields();

    fireEvent.click(
      screen.getByRole("switch", { name: "Show in command palette" })
    );
    // `singleton` defaults to true, so clicking it proves the payload tracks
    // the control rather than hard-coding the default.
    fireEvent.click(screen.getByRole("switch", { name: "Single instance" }));
    fireEvent.click(
      screen.getByRole("switch", { name: "Self improve after each run" })
    );
    openAdvanced();
    fireEvent.click(advancedCheckbox(/Run in full access mode/));

    fireEvent.click(addButton());

    await waitFor(() => expect(onAddJob).toHaveBeenCalledTimes(1));
    expect(onAddJob).toHaveBeenCalledWith({
      ...basePayload(),
      callable: true,
      singleton: false,
      selfImprove: true,
      fullAccess: true,
    });
  });
});

describe("enable-immediately gating", () => {
  it("keeps enabled false when the schedule is blank", async () => {
    const { onAddJob } = renderFlow();
    fillRequiredFields();

    // The Enabled switch only renders while a schedule is present, so set one,
    // turn the switch on, then clear the schedule again. `enableImmediately`
    // state survives that, and `effectiveEnabled` must still force false —
    // otherwise the server gets an enabled job with no cron to run it on.
    fireEvent.change(scheduleInput(), { target: { value: "*/30 * * * *" } });
    fireEvent.click(screen.getByRole("switch", { name: "Enable job" }));
    fireEvent.change(scheduleInput(), { target: { value: "" } });

    expect(screen.queryByRole("switch", { name: "Enable job" })).toBeNull();

    fireEvent.click(addButton());

    await waitFor(() => expect(onAddJob).toHaveBeenCalledTimes(1));
    expect(onAddJob).toHaveBeenCalledWith({
      ...basePayload(),
      schedule: null,
      enabled: false,
    });
  });

  it("enables the job when the switch is on and a schedule is set", async () => {
    const { onAddJob } = renderFlow();
    fillRequiredFields();

    fireEvent.change(scheduleInput(), { target: { value: "*/30 * * * *" } });
    fireEvent.click(screen.getByRole("switch", { name: "Enable job" }));

    fireEvent.click(addButton());

    await waitFor(() => expect(onAddJob).toHaveBeenCalledTimes(1));
    expect(onAddJob).toHaveBeenCalledWith({
      ...basePayload(),
      schedule: "*/30 * * * *",
      enabled: true,
    });
  });
});

describe("worktree gating", () => {
  it("omits both branches while the worktree option is unchecked", async () => {
    const { onAddJob } = renderFlow();
    fillRequiredFields();

    fireEvent.click(addButton());

    await waitFor(() => expect(onAddJob).toHaveBeenCalledTimes(1));
    // `baseBranch` holds "main" in state from mount; the payload must still
    // null it out while the worktree option is off.
    expect(onAddJob).toHaveBeenCalledWith({
      ...basePayload(),
      useWorktree: false,
      baseBranch: null,
      branchName: null,
    });
  });

  it("sends both branches once the worktree option is checked", async () => {
    const { onAddJob } = renderFlow();
    fillRequiredFields();
    openAdvanced();

    fireEvent.click(advancedCheckbox(/Run in a git worktree/));
    fireEvent.change(screen.getByTestId("job-create-worktree-branch"), {
      target: { value: "feat-y" },
    });

    fireEvent.click(addButton());

    await waitFor(() => expect(onAddJob).toHaveBeenCalledTimes(1));
    expect(onAddJob).toHaveBeenCalledWith({
      ...basePayload(),
      useWorktree: true,
      baseBranch: "main",
      branchName: "feat-y",
    });
  });
});

describe("agent type and model", () => {
  it("resets a chosen model back to null when the agent type changes", async () => {
    const { onAddJob } = renderFlow();
    fillRequiredFields();

    // Wait for the catalog: the trigger is disabled while it loads, so
    // clicking too early would never open the list.
    await waitFor(() =>
      expect(screen.getByTestId("create-agent-model").textContent).toContain(
        "Default"
      )
    );
    fireEvent.click(screen.getByTestId("create-agent-model"));
    fireEvent.click(await screen.findByRole("option", { name: "Opus" }));

    // Sanity check that the model actually took, so the reset assertion below
    // is not vacuously true.
    fireEvent.click(addButton());
    await waitFor(() => expect(onAddJob).toHaveBeenCalledTimes(1));
    expect(onAddJob).toHaveBeenLastCalledWith({
      ...basePayload(),
      model: "opus",
    });

    const agentTypeTrigger = screen
      .getAllByRole("combobox")
      .find((element) => element.textContent?.includes("Claude"));
    if (!agentTypeTrigger) throw new Error("agent type trigger not found");
    fireEvent.click(agentTypeTrigger);
    fireEvent.click(await screen.findByRole("option", { name: "Codex" }));

    fireEvent.click(addButton());
    await waitFor(() => expect(onAddJob).toHaveBeenCalledTimes(2));
    expect(onAddJob).toHaveBeenLastCalledWith({
      ...basePayload(),
      agentType: "codex",
      model: null,
    });
  });
});

describe("submit gating", () => {
  it.each([
    ["name", { name: "   " }],
    ["directory", { directory: "   " }],
    ["prompt", { prompt: "   " }],
  ])("keeps the button disabled without a %s", (_field, overrides) => {
    renderFlow();
    fillRequiredFields(overrides);

    expect(addButton().disabled).toBe(true);
  });

  it("keeps the button disabled for a non-positive timeout", () => {
    renderFlow();
    fillRequiredFields();
    openAdvanced();

    expect(addButton().disabled).toBe(false);
    fireEvent.change(timeoutInput(), {
      target: { value: "0" },
    });
    expect(addButton().disabled).toBe(true);

    fireEvent.change(timeoutInput(), {
      target: { value: "30" },
    });
    fireEvent.change(needsInputTimeoutInput(), {
      target: { value: "abc" },
    });
    expect(addButton().disabled).toBe(true);
  });

  it("keeps the button disabled while a malformed cron is entered", () => {
    renderFlow();
    fillRequiredFields();

    fireEvent.change(scheduleInput(), { target: { value: "*/30 * *" } });

    // The exact copy is pinned by jobs-helpers.test.tsx's cronError tests; here
    // it only needs to be surfaced to the user and to block the submit.
    expect(screen.getByText(/cron expression/)).toBeTruthy();
    expect(addButton().disabled).toBe(true);
  });

  it("keeps the button disabled while a submit is in flight", () => {
    renderFlow({ isAdding: true });
    fillRequiredFields();

    expect(addButton().disabled).toBe(true);
  });
});

describe("advanced settings disclosure", () => {
  it("keeps the advanced controls out of reach until the section is expanded", () => {
    renderFlow();

    expect(
      screen.queryByRole("textbox", { name: "Run timeout, minutes" })
    ).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /git worktree/ })).toBeNull();

    openAdvanced();

    expect(timeoutInput()).toBeTruthy();
    expect(advancedCheckbox(/Run in a git worktree/)).toBeTruthy();
  });
});

describe("submit outcome", () => {
  it("records the trimmed directory in cwd history after a successful add", async () => {
    const { onAddJob } = renderFlow();
    fillRequiredFields({ directory: "  /repo  " });

    fireEvent.click(addButton());

    await waitFor(() => expect(onAddJob).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem(CWD_HISTORY_KEY) ?? "[]")
      ).toEqual(["/repo"])
    );
    expect(
      JSON.parse(window.localStorage.getItem(CWD_HISTORY_USAGE_KEY) ?? "{}")
    ).toEqual({ "/repo": 1 });
  });

  it("shows the error and leaves cwd history untouched when the add fails", async () => {
    const onAddJob = vi.fn().mockRejectedValue(new Error("Job name in use"));
    renderFlow({ onAddJob });
    fillRequiredFields();

    fireEvent.click(addButton());

    expect(await screen.findByText("Job name in use")).toBeTruthy();
    expect(window.localStorage.getItem(CWD_HISTORY_KEY)).toBeNull();
  });

  it("clears a previous error when the next submit starts", async () => {
    const onAddJob = vi
      .fn()
      .mockRejectedValueOnce(new Error("Job name in use"))
      .mockResolvedValue(undefined);
    renderFlow({ onAddJob });
    fillRequiredFields();

    fireEvent.click(addButton());
    expect(await screen.findByText("Job name in use")).toBeTruthy();

    fireEvent.click(addButton());

    await waitFor(() => expect(onAddJob).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText("Job name in use")).toBeNull()
    );
  });
});
