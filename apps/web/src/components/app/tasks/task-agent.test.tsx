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
    chip: view.container.querySelector("span.rounded-full") as HTMLElement,
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
