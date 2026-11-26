import { localAgentPlacement } from "@/test-utils/__fixtures__/agent-placement";
// @vitest-environment jsdom
import type {
  AgentArchivePreview,
  AgentWorktreeStatus,
} from "@dispatch/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

// The dialog's only I/O seam is the archive-preview GET; everything else
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
    placement: localAgentPlacement,
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

function worktreeStatus(
  overrides: Partial<AgentWorktreeStatus> = {}
): AgentArchivePreview {
  return {
    subAgentCount: 0,
    cleanupDescriptions: [],
    worktreeStatus: {
      hasWorktree: true,
      hasUnmergedCommits: false,
      hasUncommittedChanges: false,
      worktreePath: "/repo/.dispatch/worktrees/worker-1",
      branchName: "agt/worker-1",
      changedFiles: [],
      uncommittedFiles: [],
      ...overrides,
    },
  };
}

const cleanupDescription =
  "Permanently deletes the owned isolated dev database and logs.";
const noCleanup = {
  worktreeStatus: null,
  subAgentCount: 0,
  cleanupDescriptions: [],
};

function renderDialog(deleteTarget: Agent) {
  const setOpen = vi.fn();
  const setDeleteTarget = vi.fn();
  const onDelete = vi.fn().mockResolvedValue(undefined);
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <DeleteAgentDialog
        open
        deleteTarget={deleteTarget}
        setOpen={setOpen}
        setDeleteTarget={setDeleteTarget}
        onDelete={onDelete}
      />
    </QueryClientProvider>
  );
  return { setOpen, setDeleteTarget, onDelete };
}

/** Wait for the in-flight archive preview to settle (Archive enabled). */
async function archiveButtonReady(): Promise<HTMLElement> {
  const confirm = screen.getByTestId("delete-agent-confirm");
  await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false));
  return confirm;
}

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockResolvedValue(noCleanup);
});

afterEach(cleanup);

describe("DeleteAgentDialog", () => {
  it("archives with auto cleanup and closes when the agent has no worktree", async () => {
    const agent = makeAgent();
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
    apiMock.mockResolvedValueOnce(worktreeStatus());
    const { setOpen, onDelete } = renderDialog(agent);

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/v1/agents/agt_target/archive-preview"
      )
    );
    fireEvent.click(await archiveButtonReady());

    await waitFor(() => expect(setOpen).toHaveBeenCalledWith(false));
    expect(onDelete).toHaveBeenCalledWith(agent, "auto");
    expect(
      screen.queryByText("Archive “worker-1” with outstanding changes?")
    ).toBeNull();
  });

  it("disables Archive while the worktree status is loading", async () => {
    const agent = makeAgent({
      worktreePath: "/repo/.dispatch/worktrees/worker-1",
    });
    let resolveStatus!: (value: AgentArchivePreview) => void;
    apiMock.mockReturnValueOnce(
      new Promise<AgentArchivePreview>((resolve) => {
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

    await screen.findByText("Archive “worker-1” with outstanding changes?");
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
    apiMock.mockResolvedValueOnce({
      ...worktreeStatus({
        hasUnmergedCommits: true,
        changedFiles: ["src/a.ts"],
      }),
      cleanupDescriptions: [cleanupDescription],
    });
    const { setOpen, setDeleteTarget, onDelete } = renderDialog(agent);

    const initial = await archiveButtonReady();
    expect(
      screen.getByText(/Permanently deletes the owned isolated dev database/)
    ).toBeTruthy();
    fireEvent.click(initial);
    const keep = await screen.findByTestId("delete-agent-keep-worktree");
    expect(
      screen.getByText(/Keeping the worktree still runs this cleanup/)
    ).toBeTruthy();
    fireEvent.click(keep);

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

  it("blocks archive if the preview fails and retries the preview", async () => {
    apiMock.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({
      ...noCleanup,
      cleanupDescriptions: [cleanupDescription],
    });
    const { onDelete } = renderDialog(makeAgent());

    const retry = await screen.findByRole("button", { name: "Retry" });
    const confirm = screen.getByTestId("delete-agent-confirm");
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(confirm);
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(retry);
    await archiveButtonReady();
    expect(screen.getByText(cleanupDescription)).toBeTruthy();
    expect(screen.queryByText(/Keeping the worktree/)).toBeNull();
  });

  it("shows a failed archive in the dialog and can retry it", async () => {
    const { setOpen, onDelete } = renderDialog(makeAgent());
    onDelete.mockRejectedValueOnce(new Error("Archive broke"));

    fireEvent.click(await archiveButtonReady());
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Archive broke"
    );
    expect(setOpen).not.toHaveBeenCalled();

    fireEvent.click(await archiveButtonReady());
    await waitFor(() => expect(setOpen).toHaveBeenCalledWith(false));
    expect(onDelete).toHaveBeenCalledTimes(2);
  });

  it("shows a failed archive on the worktree choice too", async () => {
    const agent = makeAgent({
      worktreePath: "/repo/.dispatch/worktrees/worker-1",
    });
    apiMock.mockResolvedValueOnce(
      worktreeStatus({ hasUncommittedChanges: true })
    );
    const { setOpen, onDelete } = renderDialog(agent);
    onDelete.mockRejectedValueOnce(new Error("Archive broke"));

    fireEvent.click(await archiveButtonReady());
    fireEvent.click(await screen.findByTestId("delete-agent-keep-worktree"));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Archive broke"
    );
    expect(setOpen).not.toHaveBeenCalled();
  });

  it("cannot be dismissed while the archive is in flight", async () => {
    const { setOpen, onDelete } = renderDialog(makeAgent());
    let fail!: (error: Error) => void;
    onDelete.mockReturnValueOnce(
      new Promise<void>((_, reject) => {
        fail = reject;
      })
    );

    fireEvent.click(await archiveButtonReady());
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(setOpen).not.toHaveBeenCalled();

    fail(new Error("Archive broke"));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("shows the server's cascade count and disclosed cleanup", async () => {
    apiMock.mockResolvedValueOnce({
      ...noCleanup,
      subAgentCount: 2,
      cleanupDescriptions: [cleanupDescription],
    });
    renderDialog(makeAgent());

    expect(
      await screen.findByText(/Its 2 sub agents are archived too\./)
    ).toBeTruthy();
    expect(screen.getByText(cleanupDescription)).toBeTruthy();
  });

  it("omits the dev database warning when cleanup is unconfigured", async () => {
    renderDialog(makeAgent());
    await archiveButtonReady();

    expect(screen.queryByText(/isolated dev database/)).toBeNull();
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
