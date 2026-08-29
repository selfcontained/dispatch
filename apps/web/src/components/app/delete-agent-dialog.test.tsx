// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Agent } from "@/components/app/types";

import { DeleteAgentDialog } from "./delete-agent-dialog";

// The dialog's only I/O seam is the worktree-status GET; everything else
// (step transitions, cleanup-mode choice, close-on-complete) is real.
vi.mock("@/lib/api", () => ({ api: vi.fn() }));

const { api } = await import("@/lib/api");
const apiMock = vi.mocked(api);

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agt_target",
    name: "worker-1",
    type: "claude",
    status: "running",
    cwd: "/repo",
    worktreePath: null,
    worktreeBranch: null,
    tmuxSession: "dispatch-agt_target",
    agentArgs: [],
    model: null,
    fullAccess: false,
    mediaDir: null,
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
    ...overrides,
  };
}

type WorktreeStatus = {
  hasWorktree: boolean;
  hasUnmergedCommits: boolean;
  hasUncommittedChanges: boolean;
  worktreePath: string | null;
  branchName: string | null;
  changedFiles: string[];
  uncommittedFiles: string[];
};

function worktreeStatus(
  overrides: Partial<WorktreeStatus> = {}
): WorktreeStatus {
  return {
    hasWorktree: true,
    hasUnmergedCommits: false,
    hasUncommittedChanges: false,
    worktreePath: "/repo/.dispatch/worktrees/worker-1",
    branchName: "agt/worker-1",
    changedFiles: [],
    uncommittedFiles: [],
    ...overrides,
  };
}

function renderDialog(deleteTarget: Agent, agents: Agent[] = []) {
  const setOpen = vi.fn();
  const setDeleteTarget = vi.fn();
  const onDelete = vi.fn().mockResolvedValue(undefined);
  render(
    <DeleteAgentDialog
      open
      deleteTarget={deleteTarget}
      agents={[deleteTarget, ...agents]}
      setOpen={setOpen}
      setDeleteTarget={setDeleteTarget}
      onDelete={onDelete}
    />
  );
  return { setOpen, setDeleteTarget, onDelete };
}

/** Wait for the in-flight worktree-status fetch to settle (Archive enabled). */
async function archiveButtonReady(): Promise<HTMLElement> {
  const confirm = screen.getByTestId("delete-agent-confirm");
  await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
  return confirm;
}

beforeEach(() => {
  apiMock.mockReset();
});

afterEach(cleanup);

describe("DeleteAgentDialog", () => {
  it("archives with auto cleanup and closes when the agent has no worktree", async () => {
    const agent = makeAgent();
    const { setOpen, setDeleteTarget, onDelete } = renderDialog(agent);

    // No worktree — the status endpoint must not be queried at all.
    expect(apiMock).not.toHaveBeenCalled();

    fireEvent.click(await archiveButtonReady());

    await waitFor(() => expect(setOpen).toHaveBeenCalledWith(false));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(agent, "auto");
    expect(setDeleteTarget).toHaveBeenCalledWith(null);
  });

  it("archives with auto cleanup when the worktree has no outstanding changes", async () => {
    const agent = makeAgent({
      worktreePath: "/repo/.dispatch/worktrees/worker-1",
    });
    apiMock.mockResolvedValueOnce(worktreeStatus());
    const { setOpen, onDelete } = renderDialog(agent);

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/v1/agents/agt_target/worktree-status"
      )
    );
    fireEvent.click(await archiveButtonReady());

    await waitFor(() => expect(setOpen).toHaveBeenCalledWith(false));
    expect(onDelete).toHaveBeenCalledWith(agent, "auto");
    expect(screen.queryByText("Worktree Has Outstanding Changes")).toBeNull();
  });

  it("disables Archive while the worktree status is loading", async () => {
    const agent = makeAgent({
      worktreePath: "/repo/.dispatch/worktrees/worker-1",
    });
    let resolveStatus!: (value: WorktreeStatus) => void;
    apiMock.mockReturnValueOnce(
      new Promise<WorktreeStatus>((resolve) => {
        resolveStatus = resolve;
      }) as ReturnType<typeof api>
    );
    const { onDelete } = renderDialog(agent);

    const confirm = screen.getByTestId("delete-agent-confirm");
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(true));

    // A click during load must not archive with a not-yet-known status.
    fireEvent.click(confirm);
    expect(onDelete).not.toHaveBeenCalled();

    resolveStatus(worktreeStatus({ hasUnmergedCommits: true }));
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
  });

  it("steps to the worktree choice instead of deleting when commits are unmerged", async () => {
    const agent = makeAgent({
      worktreePath: "/repo/.dispatch/worktrees/worker-1",
    });
    apiMock.mockResolvedValueOnce(
      worktreeStatus({
        hasUnmergedCommits: true,
        changedFiles: ["src/a.ts", "src/b.ts"],
      })
    );
    const { setOpen, onDelete } = renderDialog(agent);

    fireEvent.click(await archiveButtonReady());

    await screen.findByText("Worktree Has Outstanding Changes");
    expect(onDelete).not.toHaveBeenCalled();
    expect(setOpen).not.toHaveBeenCalled();
    // The unmerged branch and its files are surfaced so the choice is informed.
    expect(screen.getByText("agt/worker-1")).toBeTruthy();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("src/b.ts")).toBeTruthy();
  });

  it("surfaces uncommitted files when only uncommitted changes exist", async () => {
    const agent = makeAgent({
      worktreePath: "/repo/.dispatch/worktrees/worker-1",
    });
    apiMock.mockResolvedValueOnce(
      worktreeStatus({
        hasUncommittedChanges: true,
        uncommittedFiles: ["src/wip.ts"],
      })
    );
    renderDialog(agent);

    fireEvent.click(await archiveButtonReady());

    await screen.findByText("Worktree has uncommitted changes.");
    expect(screen.getByText("src/wip.ts")).toBeTruthy();
    // The unmerged-commits panel must not render for this leg.
    expect(screen.queryByText(/has commits not merged/)).toBeNull();
  });

  it("keeps the worktree when that choice is made", async () => {
    const agent = makeAgent({
      worktreePath: "/repo/.dispatch/worktrees/worker-1",
    });
    apiMock.mockResolvedValueOnce(
      worktreeStatus({ hasUnmergedCommits: true, changedFiles: ["src/a.ts"] })
    );
    const { setOpen, setDeleteTarget, onDelete } = renderDialog(agent);

    fireEvent.click(await archiveButtonReady());
    fireEvent.click(await screen.findByTestId("delete-agent-keep-worktree"));

    await waitFor(() => expect(setOpen).toHaveBeenCalledWith(false));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(agent, "keep");
    expect(setDeleteTarget).toHaveBeenCalledWith(null);
  });

  it("force-removes the worktree when that choice is made", async () => {
    const agent = makeAgent({
      worktreePath: "/repo/.dispatch/worktrees/worker-1",
    });
    apiMock.mockResolvedValueOnce(
      worktreeStatus({ hasUnmergedCommits: true, changedFiles: ["src/a.ts"] })
    );
    const { setOpen, onDelete } = renderDialog(agent);

    fireEvent.click(await archiveButtonReady());
    fireEvent.click(await screen.findByTestId("delete-agent-force-worktree"));

    await waitFor(() => expect(setOpen).toHaveBeenCalledWith(false));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(agent, "force");
  });

  it("falls back to a plain auto archive when the status fetch fails", async () => {
    const agent = makeAgent({
      worktreePath: "/repo/.dispatch/worktrees/worker-1",
    });
    apiMock.mockRejectedValueOnce(new Error("boom"));
    const { setOpen, onDelete } = renderDialog(agent);

    fireEvent.click(await archiveButtonReady());

    await waitFor(() => expect(setOpen).toHaveBeenCalledWith(false));
    expect(onDelete).toHaveBeenCalledWith(agent, "auto");
    expect(screen.queryByText("Worktree Has Outstanding Changes")).toBeNull();
  });

  it("names the sub agents that archive with the target", async () => {
    const agent = makeAgent();
    const child = makeAgent({ id: "agt_child", parentAgentId: "agt_target" });
    const grandchild = makeAgent({
      id: "agt_grandchild",
      parentAgentId: "agt_child",
    });
    renderDialog(agent, [child, grandchild]);

    expect(
      screen.getByText(/Its 2 sub agents are archived too\./)
    ).toBeTruthy();
  });

  it("leaves out an independent agent the target merely launched", async () => {
    const agent = makeAgent();
    // child: false — no parentAgentId, so the server cascade skips it.
    const independent = makeAgent({ id: "agt_independent" });
    renderDialog(agent, [independent]);

    expect(screen.queryByText(/sub agent/)).toBeNull();
  });

  it("cancel closes and clears the target without deleting", async () => {
    const agent = makeAgent();
    const { setOpen, setDeleteTarget, onDelete } = renderDialog(agent);

    fireEvent.click(screen.getByTestId("delete-agent-cancel"));

    expect(setOpen).toHaveBeenCalledWith(false);
    expect(setDeleteTarget).toHaveBeenCalledWith(null);
    expect(onDelete).not.toHaveBeenCalled();
  });
});
