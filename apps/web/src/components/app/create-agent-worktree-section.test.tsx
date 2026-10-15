// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorktreeSection } from "./create-agent-worktree-section";

const defaultProps = {
  cwd: "/repo/app",
  worktreeAvailable: true,
  useWorktree: true,
  onUseWorktreeChange: vi.fn(),
  baseBranch: "main",
  onBaseBranchChange: vi.fn(),
  worktreeBranch: "feature/saved",
  onWorktreeBranchChange: vi.fn(),
  createNewBranch: true,
  onCreateNewBranchChange: vi.fn(),
};

afterEach(cleanup);

function checkbox(testId: string): HTMLButtonElement {
  return screen.getByTestId(testId) as HTMLButtonElement;
}

describe("WorktreeSection", () => {
  it("renders saved true values unchecked and hides branch controls outside a git repo", () => {
    render(<WorktreeSection {...defaultProps} worktreeAvailable={false} />);

    const worktree = checkbox("create-agent-worktree");

    expect(worktree.getAttribute("aria-checked")).toBe("false");
    expect(worktree.disabled).toBe(true);
    expect(screen.queryByTestId("create-agent-base-branch")).toBeNull();
    expect(screen.queryByTestId("create-agent-new-branch")).toBeNull();
    expect(screen.queryByTestId("create-agent-worktree-branch")).toBeNull();
  });

  it("uses saved values when the cwd is a git repo", () => {
    render(<WorktreeSection {...defaultProps} />);

    const worktree = checkbox("create-agent-worktree");
    const newBranch = checkbox("create-agent-new-branch");

    expect(worktree.getAttribute("aria-checked")).toBe("true");
    expect(worktree.disabled).toBe(false);
    expect(newBranch.getAttribute("aria-checked")).toBe("true");
    expect(
      (screen.getByTestId("create-agent-base-branch") as HTMLButtonElement)
        .disabled
    ).toBe(false);
    expect(
      (screen.getByTestId("create-agent-worktree-branch") as HTMLInputElement)
        .value
    ).toBe("feature/saved");
  });

  it("hides the branch name input when not creating a new branch", () => {
    render(<WorktreeSection {...defaultProps} createNewBranch={false} />);

    expect(
      checkbox("create-agent-new-branch").getAttribute("aria-checked")
    ).toBe("false");
    expect(screen.getByTestId("create-agent-base-branch")).toBeTruthy();
    expect(screen.queryByTestId("create-agent-worktree-branch")).toBeNull();
  });

  it("hides branch controls when worktrees are off", () => {
    render(<WorktreeSection {...defaultProps} useWorktree={false} />);

    const worktree = checkbox("create-agent-worktree");

    expect(worktree.getAttribute("aria-checked")).toBe("false");
    expect(worktree.disabled).toBe(false);
    expect(screen.queryByTestId("create-agent-base-branch")).toBeNull();
    expect(screen.queryByTestId("create-agent-new-branch")).toBeNull();
    expect(screen.queryByTestId("create-agent-worktree-branch")).toBeNull();
  });
});
