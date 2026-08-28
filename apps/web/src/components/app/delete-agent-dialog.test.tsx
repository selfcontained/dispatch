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

type AgentWorktreeStatus = WorktreeStatus & {
  agentId: string;
  agentName: string;
  isTarget: boolean;
};

/** One agent's entry in the subtree payload. */
function agentStatus(
  overrides: Partial<AgentWorktreeStatus> = {}
): AgentWorktreeStatus {
  return {
    agentId: "agt_target",
    agentName: "worker-1",
    isTarget: true,
    ...worktreeStatus(overrides),
    ...overrides,
  };
}

/** The subtree endpoint's response envelope. */
function subtree(...statuses: AgentWorktreeStatus[]) {
  return { statuses };
}

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
    apiMock.mockResolvedValueOnce(subtree());
    const { setOpen, setDeleteTarget, onDelete } = renderDialog(agent);

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
    apiMock.mockResolvedValueOnce(subtree(agentStatus()));
    const { setOpen, onDelete } = renderDialog(agent);

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/v1/agents/agt_target/worktree-status/subtree"
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
    let resolveStatus!: (value: { statuses: AgentWorktreeStatus[] }) => void;
    apiMock.mockReturnValueOnce(
      new Promise<{ statuses: AgentWorktreeStatus[] }>((resolve) => {
        resolveStatus = resolve;
      }) as ReturnType<typeof api>
    );
    const { onDelete } = renderDialog(agent);

    const confirm = screen.getByTestId("delete-agent-confirm");
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(true));

    // A click during load must not archive with a not-yet-known status.
    fireEvent.click(confirm);
    expect(onDelete).not.toHaveBeenCalled();

    resolveStatus(subtree(agentStatus({ hasUnmergedCommits: true })));
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
  });

  it("steps to the worktree choice instead of deleting when commits are unmerged", async () => {
    const agent = makeAgent({
      worktreePath: "/repo/.dispatch/worktrees/worker-1",
    });
    apiMock.mockResolvedValueOnce(
      subtree(
        agentStatus({
          hasUnmergedCommits: true,
          changedFiles: ["src/a.ts", "src/b.ts"],
        })
      )
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
      subtree(
        agentStatus({
          hasUncommittedChanges: true,
          uncommittedFiles: ["src/wip.ts"],
        })
      )
    );
    renderDialog(agent);

    fireEvent.click(await archiveButtonReady());

    await screen.findByText("Worktree Has Outstanding Changes");
    expect(screen.getByText("Uncommitted changes:")).toBeTruthy();
    expect(screen.getByText("src/wip.ts")).toBeTruthy();
    // The unmerged-commits panel must not render for this leg.
    expect(screen.queryByText("Commits not merged to origin:")).toBeNull();
  });

  it("keeps the worktree when that choice is made", async () => {
    const agent = makeAgent({
      worktreePath: "/repo/.dispatch/worktrees/worker-1",
    });
    apiMock.mockResolvedValueOnce(
      subtree(
        agentStatus({ hasUnmergedCommits: true, changedFiles: ["src/a.ts"] })
      )
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
      subtree(
        agentStatus({ hasUnmergedCommits: true, changedFiles: ["src/a.ts"] })
      )
    );
    const { setOpen, onDelete } = renderDialog(agent);

    fireEvent.click(await archiveButtonReady());
    fireEvent.click(await screen.findByTestId("delete-agent-force-worktree"));

    await waitFor(() => expect(setOpen).toHaveBeenCalledWith(false));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(agent, "force");
  });

  it("stops on a sub agent's outstanding work even when the target is clean", async () => {
    const agent = makeAgent({
      worktreePath: "/repo/.dispatch/worktrees/worker-1",
    });
    apiMock.mockResolvedValueOnce(
      subtree(
        agentStatus(),
        agentStatus({
          agentId: "agt_child",
          agentName: "builder-3",
          isTarget: false,
          branchName: "agt/builder-3",
          hasUncommittedChanges: true,
          uncommittedFiles: ["src/wip.ts"],
        })
      )
    );
    const { onDelete } = renderDialog(agent);

    fireEvent.click(await archiveButtonReady());

    // The whole point: the parent looks clean, but archiving it discards the
    // child's work, so the user is asked rather than told afterwards.
    await screen.findByText("Worktree Has Outstanding Changes");
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText("builder-3")).toBeTruthy();
    expect(screen.getByText("(sub agent)")).toBeTruthy();
    expect(screen.getByText("src/wip.ts")).toBeTruthy();
  });

  it("counts every dirty worktree in the cascade in the heading", async () => {
    const agent = makeAgent({
      worktreePath: "/repo/.dispatch/worktrees/worker-1",
    });
    apiMock.mockResolvedValueOnce(
      subtree(
        agentStatus({
          hasUncommittedChanges: true,
          uncommittedFiles: ["src/a.ts"],
        }),
        agentStatus({
          agentId: "agt_child",
          agentName: "builder-3",
          isTarget: false,
          hasUncommittedChanges: true,
          uncommittedFiles: ["src/b.ts"],
        })
      )
    );
    renderDialog(agent);

    fireEvent.click(await archiveButtonReady());

    await screen.findByText("2 Worktrees Have Outstanding Changes");
    expect(screen.getByTestId("delete-agent-force-worktree").textContent).toBe(
      "Archive and remove worktrees"
    );
  });

  it("blocks archiving and offers a retry when the status check fails", async () => {
    const agent = makeAgent({
      worktreePath: "/repo/.dispatch/worktrees/worker-1",
    });
    apiMock.mockRejectedValueOnce(new Error("boom"));
    const { setOpen, onDelete } = renderDialog(agent);

    // Falling through to an archive here would skip the worktree confirmation
    // at the one moment we cannot say what it would discard.
    await screen.findByTestId("worktree-check-failed");
    expect(screen.queryByTestId("delete-agent-confirm")).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
    expect(setOpen).not.toHaveBeenCalled();
  });

  it("archives normally once a retried status check succeeds", async () => {
    const agent = makeAgent({
      worktreePath: "/repo/.dispatch/worktrees/worker-1",
    });
    apiMock.mockRejectedValueOnce(new Error("boom"));
    apiMock.mockResolvedValueOnce(subtree(agentStatus()));
    const { setOpen, onDelete } = renderDialog(agent);

    fireEvent.click(await screen.findByTestId("delete-agent-retry-status"));

    fireEvent.click(await archiveButtonReady());
    await waitFor(() => expect(setOpen).toHaveBeenCalledWith(false));
    expect(onDelete).toHaveBeenCalledWith(agent, "auto");
  });

  it("withholds the destructive choice when the preview is incomplete", async () => {
    const agent = makeAgent({
      worktreePath: "/repo/.dispatch/worktrees/worker-1",
    });
    apiMock.mockResolvedValueOnce({
      statuses: [agentStatus()],
      complete: false,
    });
    const { onDelete } = renderDialog(agent);

    fireEvent.click(await archiveButtonReady());

    // Nothing looked dirty, but the walk was cut short — so the archive must
    // not proceed silently, and removing worktrees must not be on offer.
    await screen.findByTestId("worktree-preview-incomplete");
    expect(onDelete).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("delete-agent-force-worktree").hasAttribute("disabled")
    ).toBe(true);
    // Keeping them is still a safe way out.
    expect(
      screen.getByTestId("delete-agent-keep-worktree").hasAttribute("disabled")
    ).toBe(false);
  });

  it("cancel closes and clears the target without deleting", async () => {
    const agent = makeAgent();
    apiMock.mockResolvedValueOnce(subtree());
    const { setOpen, setDeleteTarget, onDelete } = renderDialog(agent);

    fireEvent.click(screen.getByTestId("delete-agent-cancel"));

    expect(setOpen).toHaveBeenCalledWith(false);
    expect(setDeleteTarget).toHaveBeenCalledWith(null);
    expect(onDelete).not.toHaveBeenCalled();
  });
});
