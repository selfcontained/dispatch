// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { RunnerUpdateView } from "@dispatch/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runnersQueryKey, type Runner } from "@/hooks/use-runners";
import { api, ApiError } from "@/lib/api";
import { RunnerHealthDetails } from "./runner-health";
import { RunnerUpdateStatus } from "./runner-update";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: vi.fn(),
}));
vi.mock("./runner-onboarding", () => ({
  RunnerCommand: ({ value }: { value: string }) => (
    <pre data-testid="command">{value}</pre>
  ),
  useRunnerInstaller: () => ({
    data: { version: "1.8.0", revision: "bbbbbbb", command: "update-command" },
  }),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const runner = (
  update?: RunnerUpdateView,
  status: Runner["status"] = "online"
): Runner => ({
  id: "rnr/one",
  name: "Build machine",
  status,
  workspaces: [],
  update,
  healthReceivedAt: "2026-01-15T08:42:17.123Z",
  health: {
    version: "1.7.0",
    revision: "aaaaaaa",
    sessions: 1,
    working: 0,
    cpuPercent: 1,
    memoryUsed: 1,
    memoryTotal: 2,
  },
});

function show(
  update?: RunnerUpdateView,
  health = false,
  automaticUpdates?: boolean
) {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const tree = (next?: RunnerUpdateView, status?: Runner["status"]) => (
    <QueryClientProvider client={client}>
      <RunnerUpdateStatus
        runner={{ ...runner(next, status), automaticUpdates }}
      />
      {health && <RunnerHealthDetails runner={runner(next, status)} />}
    </QueryClientProvider>
  );
  const view = render(tree(update));
  return {
    invalidate,
    update: (next?: RunnerUpdateView, status?: Runner["status"]) =>
      view.rerender(tree(next, status)),
  };
}

const text = () => screen.getByTestId("runner-update").textContent;
const version = "1.8.0";
const available = { version, action: "update" } as const;

it("offers Update with its consequence", () => {
  show({ available });
  expect(text()).toContain("Update available: 1.8.0");
  expect(text()).toContain("Updating closes open terminals on this runner.");
  expect(screen.getByRole("button", { name: "Update" })).toBeTruthy();
});

it.each([
  ["staging", "Downloading and verifying…"],
  ["settling", "Waiting for work to settle…"],
  ["switching", "Switching to the new build…"],
  ["confirming", "Confirming the new build…"],
  ["cancelling", "Cancelling the update…"],
] as const)("shows %s", (phase, progress) => {
  show({ attempt: { id: "a", phase, version } });
  expect(text()).toContain("Updating to 1.8.0");
  expect(text()).toContain(progress);
  expect(text()).not.toContain("New work waits");
  expect(screen.queryByRole("button")).toBeNull();
});

it("replaces the update phase while offline and restores it on reconnect", () => {
  const update = {
    attempt: { id: "a", phase: "resuming", version, agents: 3 },
  } as const;
  const view = show(update);
  expect(text()).toContain("Resuming 3 agents");
  view.update(update, "offline");
  expect(text()).toContain("Updating to 1.8.0");
  expect(text()).toContain("Waiting for the runner to reconnect…");
  expect(text()).not.toContain("Resuming 3 agents");
  view.update(update, "online");
  expect(text()).toContain("Resuming 3 agents");
  expect(text()).not.toContain("Waiting for the runner to reconnect…");
});

it("shows only the reconnect line, not the agent count, while draining offline", () => {
  const update = {
    attempt: { id: "a", phase: "draining", version, agents: 2 },
  } as const;
  const view = show(update);
  expect(text()).toContain("Waiting on 2 agents");
  view.update(update, "offline");
  expect(text()).toContain("Waiting for the runner to reconnect…");
  expect(text()).not.toContain("Waiting on");
  expect(text()).not.toContain("2 agents");
  // Cancel is still offered while the drain is offline.
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
});

it("says new work waits once, and only while, it is held", () => {
  const view = show({ attempt: { id: "a", phase: "staging", version } });
  expect(text()).not.toContain("New work waits");
  view.update({ attempt: { id: "a", phase: "settling", version, held: true } });
  expect(text()).toContain("New work waits until the update finishes.");
});

it("asks before Update now, and forces only on the confirm", async () => {
  vi.mocked(api).mockResolvedValue({ attemptId: "a" });
  const waiting = {
    attempt: { id: "a", phase: "draining", version, agents: 2 },
  } as const;
  show(waiting);
  fireEvent.click(screen.getByRole("button", { name: "Update now" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog.textContent).toContain("Update Build machine now?");
  expect(dialog.textContent).toContain(
    "Running turns are interrupted and resumed after the update. Open terminals close, and any tool call in progress is lost."
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(api).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Update now" }));
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Update now",
    })
  );
  await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(1));
  expect(api).toHaveBeenCalledWith("/api/v1/runners/rnr%2Fone/update", {
    method: "POST",
    body: '{"action":"force","attemptId":"a"}',
  });
});

it("closes the question when the wait ends by itself", async () => {
  const view = show({ attempt: { id: "a", phase: "draining", version } });
  fireEvent.click(screen.getByRole("button", { name: "Update now" }));
  await screen.findByRole("alertdialog");
  view.update({ attempt: { id: "a", phase: "settling", version } });
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it.each([
  ["interrupting", undefined, "Interrupting agents…"],
  ["interrupting", 1, "Interrupting 1 agent"],
  ["interrupting", 3, "Interrupting 3 agents"],
  ["resuming", 3, "Resuming 3 agents"],
] as const)("shows %s with %s agents", (phase, agents, progress) => {
  show({ attempt: { id: "a", phase, version, agents, held: true } });
  expect(text()).toContain(progress);
  expect(text()).not.toContain("New work waits");
  expect(screen.queryByRole("button")).toBeNull();
});

it.each([
  [1, "1 agent still on the previous build"],
  [3, "3 agents still on the previous build"],
])("counts %d agents on the previous build", (count, words) => {
  show({ result: { state: "updated", version }, previousBuildAgents: count });
  expect(text()).toContain("Updated to 1.8.0");
  expect(text()).toContain(words);
  expect(screen.queryByRole("button")).toBeNull();
});

it("puts a newer update ahead of the last success", () => {
  show({ result: { state: "updated", version: "1.7.0" }, available });
  expect(text()).toContain("Update available: 1.8.0");
  expect(text()).not.toContain("Updated to");
});

it.each([
  ["boot_failed", "The new build didn’t start."],
  ["confirm_timeout", "The new build wasn’t confirmed in time."],
  ["reattach_failed", "Running agents didn’t reconnect to the new build."],
  [
    "trial_interrupted",
    "The runner was interrupted while testing the new build.",
  ],
  ["verify_failed", "The new build didn’t match the one Dispatch sent."],
  ["dispatch_changed", "Dispatch changed builds during the update."],
  ["unknown_code", "The runner restored its previous build."],
])("explains a rollback for %s", (reason, words) => {
  show({
    result: { state: "rolled_back", version, reason },
    available: { version, action: "retry" },
  });
  expect(text()).toContain("Update to 1.8.0 rolled back");
  expect(text()).toContain(words);
  expect(text()).toContain(
    "This build is blocked on this runner until you retry."
  );
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});

it.each([
  ["force_timeout", "Dispatch couldn’t stop every agent in time."],
  ["operations_pending", "The runner was still busy, so it didn’t switch."],
  ["verify_failed", "The runner couldn’t download or verify the build."],
  ["settle_timeout", "Work on the runner didn’t settle in time."],
  [
    "attach_unavailable",
    "Dispatch couldn’t reach every agent running on the runner.",
  ],
  ["no_response", "The runner didn’t report back in time."],
  ["unknown_code", "The runner stopped the update."],
])("explains a deferral for %s", (reason, words) => {
  show({ result: { state: "deferred", version, reason }, available });
  expect(text()).toContain("Update to 1.8.0 didn’t finish");
  expect(text()).toContain(words);
  expect(screen.getByRole("button", { name: "Update" })).toBeTruthy();
});

it.each([
  ["drain_cancelled", true],
  ["drain_cancelled", false],
  ["drain_cancelled", undefined],
  ["automatic_drain_cancelled", true],
  ["automatic_drain_cancelled", false],
] as const)(
  "explains %s with automatic updates set to %s",
  (reason, automatic) => {
    show(
      { result: { state: "deferred", version, reason }, available },
      false,
      automatic
    );
    expect(text()).toContain("Update to 1.8.0 was cancelled");
    expect(screen.getByRole("button", { name: "Update" })).toBeTruthy();
    const skip = screen.queryByText(
      "Automatic updates will skip this build. Select Update to install it."
    );
    expect(Boolean(skip)).toBe(automatic === true);
  }
);

it.each([
  [true, true, true],
  [true, undefined, false],
  [false, true, false],
] as const)(
  "with automatic=%s and skipped=%s explains the paused build: %s",
  (automatic, automaticSkipped, explained) => {
    show(
      {
        result: {
          state: "deferred",
          version,
          reason: "settle_timeout",
          automaticSkipped,
        },
        available,
      },
      false,
      automatic
    );
    expect(text()).toContain("Work on the runner didn’t settle in time.");
    expect(
      Boolean(
        screen.queryByText(
          "Automatic updates will skip this build. Select Update to install it."
        )
      )
    ).toBe(explained);
  }
);

it("names the floor of a refused downgrade", () => {
  show({
    result: {
      state: "deferred",
      version,
      reason: "downgrade",
      floorVersion: "1.9.0",
    },
  });
  expect(text()).toContain("Update to 1.8.0 was refused");
  expect(text()).toContain("Its version floor is 1.9.0.");
});

it("offers Retry for a suppressed build and sends it", async () => {
  vi.mocked(api).mockResolvedValue({ attemptId: "a" });
  const { invalidate } = show({
    result: { state: "deferred", version, reason: "suppressed" },
    available: { version, action: "retry" },
  });
  expect(text()).toContain("Update to 1.8.0 is blocked");
  expect(text()).toContain("This build failed on this runner before.");
  // The title already says so.
  expect(text()).not.toContain("until you retry");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await vi.waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({ queryKey: runnersQueryKey })
  );
  expect(api).toHaveBeenCalledWith("/api/v1/runners/rnr%2Fone/update", {
    method: "POST",
    body: '{"action":"retry"}',
  });
});

it("names the newer build next to an older failure", () => {
  show({
    result: { state: "rolled_back", version, reason: "dispatch_changed" },
    available: { version: "1.8.1", action: "update" },
  });
  expect(text()).toContain("Update available: 1.8.1");
});

it("sends one request while the first is pending", async () => {
  vi.mocked(api).mockReturnValue(new Promise(() => {}));
  show({ available });
  const button = screen.getByRole<HTMLButtonElement>("button");
  fireEvent.click(button);
  await vi.waitFor(() => expect(button.disabled).toBe(true));
  fireEvent.click(button);
  expect(api).toHaveBeenCalledTimes(1);
  expect(api).toHaveBeenCalledWith("/api/v1/runners/rnr%2Fone/update", {
    method: "POST",
    body: '{"action":"update"}',
  });
});

it("shows a refusal, its command, and drops it once an update runs", async () => {
  vi.mocked(api).mockRejectedValue(
    new ApiError(409, "No signed build.", "no_artifact")
  );
  const view = show({ available });
  fireEvent.click(screen.getByRole("button"));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "No signed build."
  );
  expect(screen.getByTestId("command").textContent).toBe("update-command");
  expect(view.invalidate).toHaveBeenCalled();
  view.update({ attempt: { id: "a", phase: "staging", version } });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByTestId("command")).toBeNull();
  view.update({ result: { state: "updated", version } });
  expect(screen.queryByRole("alert")).toBeNull();
});

describe("the manual command", () => {
  it.each([
    ["without the capability", undefined, 1],
    ["after a refusal it cannot retry", { result: { state: "deferred" } }, 1],
    ["while it can update itself", { available }, 0],
    [
      "after the runner's floor refused this build",
      { available, result: { state: "deferred", reason: "downgrade" } },
      1,
    ],
    ["while updating", { attempt: { id: "a", phase: "staging" } }, 0],
    ["when all agents must be idle", { result: { state: "needs_idle" } }, 1],
  ] as const)("shows %s", (_case, update, count) => {
    show(update as RunnerUpdateView | undefined, true);
    expect(screen.queryAllByTestId("command")).toHaveLength(count);
  });

  it("explains needing all agents idle without a button", () => {
    show({ result: { state: "needs_idle", version } });
    expect(text()).toContain("Update to 1.8.0 needs all agents idle");
    expect(text()).toContain(
      "This build can’t take over running agents. When they’re idle, run this on the runner."
    );
    expect(screen.getByTestId("command")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders no update state for an unchanged runner", () => {
    show(undefined);
    expect(screen.queryByTestId("runner-update")).toBeNull();
  });
});
