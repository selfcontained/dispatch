// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";
import { AgentCardActivity } from "@/components/app/agent-card-status";
import { upcomingSchedulesKey } from "@/components/app/scheduled-messages";
import { TaskAgentChip } from "./task-agent";

vi.mock("@/hooks/use-projects", () => ({
  useProjectScope: () => ({ projectId: null }),
}));
vi.mock("@/lib/api", () => ({ api: vi.fn().mockResolvedValue({}) }));

afterEach(cleanup);

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agt_parent",
    name: "builder",
    type: "codex",
    status: "running",
    cwd: "/repo",
    worktreePath: null,
    worktreeBranch: null,
    agentArgs: [],
    model: null,
    fullAccess: false,
    filesDir: null,
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
    ...overrides,
  };
}

function renderActivity(
  parent: Agent,
  children: Agent[] = [],
  compact = false
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(upcomingSchedulesKey, {});
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TaskAgentChip
          agent={parent}
          agents={[parent, ...children]}
          compact={compact}
        />
        <AgentCardActivity agent={parent} childAgents={children} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return {
    client,
    view,
    chip: screen.getByTestId(`task-agent-chip-${parent.id}`),
  };
}

function setStep(
  client: QueryClient,
  id: string,
  blockId: string,
  label: string
) {
  act(() => {
    client.setQueryData(["agent-turn-reported", id], true);
    client.setQueryData(["agent-turn-label", id, blockId], label);
  });
}

describe("TaskAgentChip activity", () => {
  it.each([
    [
      { status: "creating" as const },
      "Starting…",
      "border-status-working/40",
      true,
    ],
    [
      { status: "archiving" as const, archivePhase: "worktree-check" as const },
      "Checking worktree…",
      "border-orange-400/40",
      true,
    ],
    [
      { reconnect: { phase: "trying" as const } as Agent["reconnect"] },
      "Reconnecting",
      "border-status-waiting/40",
      true,
    ],
    [{ activity: "waiting" as const }, null, "border-status-waiting/40", false],
    [{ activity: "blocked" as const }, null, "border-status-blocked/40", false],
    [{ activity: "idle" as const }, null, "border-border", false],
    [
      { status: "stopped" as const, activity: "stopped" as const },
      null,
      "border-dashed",
      false,
    ],
  ])("renders state %#", (state, label, tint, glyph) => {
    const parent = agent(state);
    const { chip } = renderActivity(parent);
    expect(chip.className).toContain(tint);
    expect(chip.textContent).toContain(label ?? parent.name);
    expect(Boolean(screen.queryByTestId(`task-agent-live-${parent.id}`))).toBe(
      glyph
    );
  });

  it("shows the own step and hides its label in compact mode", async () => {
    const parent = agent({
      currentTurn: { blockId: "blk_own", threadId: null },
    });
    const { client, chip } = renderActivity(parent);
    setStep(client, parent.id, "blk_own", "running tests");
    await waitFor(() => expect(chip.textContent).toContain("running tests"));
    expect(chip.className).toContain("border-status-working/40");
    cleanup();
    const compact = renderActivity(parent, [], true);
    setStep(compact.client, parent.id, "blk_own", "running tests");
    await waitFor(() =>
      expect(screen.getByTestId(`task-agent-live-${parent.id}`)).toBeTruthy()
    );
    expect(compact.chip.textContent).not.toContain("running tests");
  });

  it("matches the sidebar's label when a child's turn stands in", async () => {
    const parent = agent({ activity: "idle" });
    const child = agent({
      id: "agt_child",
      name: "reviewer",
      parentAgentId: parent.id,
      currentTurn: { blockId: "blk_child", threadId: null },
    });
    const { client, chip } = renderActivity(parent, [child]);
    setStep(client, child.id, "blk_child", "running tests");
    await waitFor(() =>
      expect(chip.textContent).toContain("↳ reviewer · running tests")
    );
    expect(chip.className).toContain("border-status-working/40");
    expect(screen.getByTestId(`task-agent-live-${parent.id}`)).toBeTruthy();
    expect(
      screen.getByTestId(`agent-status-line-${parent.id}`).textContent
    ).toContain("running tests");
    expect(screen.getByTestId(`agent-activity-${child.id}`)).toBeTruthy();
  });

  it("keeps a waiting parent's tint while its child's step stands in", async () => {
    const parent = agent({ activity: "waiting" });
    const child = agent({
      id: "agt_child",
      name: "reviewer",
      parentAgentId: parent.id,
      currentTurn: { blockId: "blk_child", threadId: null },
    });
    const { client, chip } = renderActivity(parent, [child]);
    setStep(client, child.id, "blk_child", "running tests");
    await waitFor(() =>
      expect(chip.textContent).toContain("↳ reviewer · running tests")
    );
    expect(chip.className).toContain("border-status-waiting/40");
  });

  it.each([
    [{ activity: "idle" as const }, "Idle"],
    [{ status: "stopped" as const, activity: "stopped" as const }, "Stopped"],
    [{ activity: "waiting" as const }, "Waiting"],
  ])(
    "keeps a quiet activity row when there is nothing to report %#",
    (state, label) => {
      const parent = agent(state);
      const { chip } = renderActivity(parent);
      expect(chip.dataset.layout).toBe("stacked");
      expect(
        screen.getByTestId(`task-agent-activity-${parent.id}`).textContent
      ).toBe(label);
    }
  );

  it("stacks a child's step under the name, and stays one row when compact", async () => {
    const parent = agent({ activity: "idle" });
    const child = agent({
      id: "agt_child",
      name: "reviewer",
      parentAgentId: parent.id,
      currentTurn: { blockId: "blk_child", threadId: null },
    });
    const stacked = renderActivity(parent, [child]);
    setStep(stacked.client, child.id, "blk_child", "running tests");
    await waitFor(() =>
      expect(
        screen.getByTestId(`task-agent-activity-${parent.id}`).textContent
      ).toContain("↳ reviewer · running tests")
    );
    // Beside the text that says it, the glyph is decorative.
    expect(
      screen
        .getByTestId(`task-agent-live-${parent.id}`)
        .getAttribute("aria-hidden")
    ).toBe("true");
    cleanup();
    const compact = renderActivity(parent, [child], true);
    setStep(compact.client, child.id, "blk_child", "running tests");
    await waitFor(() =>
      expect(screen.getByTestId(`task-agent-live-${parent.id}`)).toBeTruthy()
    );
    expect(compact.chip.dataset.layout).toBe("compact");
    // Alone, the glyph names the child doing the work; the name is capped.
    expect(
      screen
        .getByTestId(`task-agent-live-${parent.id}`)
        .getAttribute("aria-label")
    ).toBe("↳ reviewer · running tests");
    expect(screen.getByText(parent.name).className).toContain("max-w-28");
    expect(screen.queryByTestId(`task-agent-activity-${parent.id}`)).toBeNull();
    expect(compact.chip.textContent).not.toContain("running tests");
  });

  it.each([
    ["waiting" as const, "border-status-waiting/40"],
    ["blocked" as const, "border-status-blocked/40"],
    ["stopped" as const, "border-dashed"],
  ])(
    "keeps a %s agent's tint behind its next schedule",
    async (activity, tint) => {
      const { client, chip } = renderActivity(agent({ activity }));
      act(() =>
        client.setQueryData(upcomingSchedulesKey, {
          agt_parent: { nextDueAt: "2026-07-15T18:00:00.000Z" },
        })
      );
      await waitFor(() => expect(chip.textContent).toContain("Next "));
      expect(chip.className).toContain(tint);
    }
  );

  describe("schedule reminder", () => {
    const schedule = { agt_parent: { nextDueAt: "2026-07-15T18:00:00.000Z" } };

    it("shows a clock and the next reminder, stacked or compact, and clears with the schedule", async () => {
      const parent = agent({ activity: "idle" });
      const { client } = renderActivity(parent);
      act(() => client.setQueryData(upcomingSchedulesKey, schedule));
      const sidebar = () =>
        screen.getByTestId(`agent-status-line-${parent.id}`).textContent;
      await waitFor(() =>
        expect(
          screen.getByTestId(`task-agent-activity-${parent.id}`).textContent
        ).toBe(sidebar())
      );
      expect(sidebar()).toMatch(/^Next /);
      expect(
        screen.getByTestId(`task-agent-live-${parent.id}`).querySelector("svg")
      ).toBeTruthy();

      act(() => client.setQueryData(upcomingSchedulesKey, {}));
      await waitFor(() =>
        expect(
          screen.getByTestId(`task-agent-activity-${parent.id}`).textContent
        ).toBe("Idle")
      );
      expect(screen.queryByTestId(`task-agent-live-${parent.id}`)).toBeNull();

      cleanup();
      const compact = renderActivity(parent, [], true);
      act(() => compact.client.setQueryData(upcomingSchedulesKey, schedule));
      await waitFor(() =>
        expect(
          screen
            .getByTestId(`task-agent-live-${parent.id}`)
            .getAttribute("aria-label")
        ).toMatch(/^Next /)
      );
      expect(compact.chip.textContent).not.toContain("Next");
    });

    it("gives way to the agent's own step and to a child's step", async () => {
      const own = agent({
        activity: "working",
        currentTurn: { blockId: "blk_own", threadId: null },
      });
      const first = renderActivity(own);
      act(() => first.client.setQueryData(upcomingSchedulesKey, schedule));
      setStep(first.client, own.id, "blk_own", "editing files");
      await waitFor(() =>
        expect(first.chip.textContent).toContain("editing files")
      );
      expect(first.chip.textContent).not.toContain("Next");

      cleanup();
      const parent = agent({ activity: "idle" });
      const child = agent({
        id: "agt_child",
        name: "reviewer",
        parentAgentId: parent.id,
        currentTurn: { blockId: "blk_child", threadId: null },
      });
      const second = renderActivity(parent, [child]);
      act(() => second.client.setQueryData(upcomingSchedulesKey, schedule));
      setStep(second.client, child.id, "blk_child", "running tests");
      await waitFor(() =>
        expect(second.chip.textContent).toContain("↳ reviewer · running tests")
      );
      expect(second.chip.textContent).not.toContain("Next");
    });
  });

  it("shares phase and schedule labels with the sidebar", async () => {
    const parent = agent({ status: "archiving", archivePhase: "finalizing" });
    const { chip } = renderActivity(parent);
    expect(chip.textContent).toContain(
      screen.getByTestId(`agent-status-line-${parent.id}`).textContent
    );
    cleanup();
    const scheduled = renderActivity(agent({ activity: "idle" }));
    act(() =>
      scheduled.client.setQueryData(upcomingSchedulesKey, {
        agt_parent: { nextDueAt: "2026-07-15T18:00:00.000Z" },
      })
    );
    await waitFor(() => expect(scheduled.chip.textContent).toContain("Next "));
    expect(scheduled.chip.textContent).toContain(
      screen.getByTestId("agent-status-line-agt_parent").textContent
    );
  });
});
