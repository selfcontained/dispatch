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

function branchInput(): HTMLInputElement {
  return screen.getByTestId("create-agent-worktree-branch") as HTMLInputElement;
}

function baseBranch(): HTMLButtonElement {
  return screen.getByTestId("create-agent-base-branch") as HTMLButtonElement;
}

describe("WorktreeSection", () => {
  it("renders saved true values unchecked and collapses branch controls outside a git repo", () => {
    render(<WorktreeSection {...defaultProps} worktreeAvailable={false} />);

    const worktree = checkbox("create-agent-worktree");

    expect(worktree.getAttribute("aria-checked")).toBe("false");
    expect(worktree.disabled).toBe(true);
    expect(checkbox("create-agent-new-branch").disabled).toBe(true);
    expect(baseBranch().disabled).toBe(true);
    expect(branchInput().disabled).toBe(true);
  });

  it("uses saved values when the cwd is a git repo", () => {
    render(<WorktreeSection {...defaultProps} />);

    const worktree = checkbox("create-agent-worktree");
    const newBranch = checkbox("create-agent-new-branch");

    expect(worktree.getAttribute("aria-checked")).toBe("true");
    expect(worktree.disabled).toBe(false);
    expect(newBranch.getAttribute("aria-checked")).toBe("true");
    expect(newBranch.disabled).toBe(false);
    expect(baseBranch().disabled).toBe(false);
    expect(branchInput().disabled).toBe(false);
    expect(branchInput().value).toBe("feature/saved");
  });

  it("keeps the branch name input empty and disabled when not creating a new branch", () => {
    render(<WorktreeSection {...defaultProps} createNewBranch={false} />);

    expect(
      checkbox("create-agent-new-branch").getAttribute("aria-checked")
    ).toBe("false");
    expect(baseBranch().disabled).toBe(false);
    expect(branchInput().disabled).toBe(true);
    expect(branchInput().value).toBe("");
    expect(branchInput().placeholder).toBe("");
  });

  it("collapses branch controls when worktrees are off", () => {
    render(<WorktreeSection {...defaultProps} useWorktree={false} />);

    const worktree = checkbox("create-agent-worktree");

    expect(worktree.getAttribute("aria-checked")).toBe("false");
    expect(worktree.disabled).toBe(false);
    expect(checkbox("create-agent-new-branch").disabled).toBe(true);
    expect(baseBranch().disabled).toBe(true);
    expect(branchInput().disabled).toBe(true);
  });
});
