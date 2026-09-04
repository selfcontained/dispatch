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
  it("renders saved true values unchecked and disabled outside a git repo", () => {
    render(<WorktreeSection {...defaultProps} worktreeAvailable={false} />);

    const worktree = checkbox("create-agent-worktree");
    const newBranch = checkbox("create-agent-new-branch");

    expect(worktree.getAttribute("aria-checked")).toBe("false");
    expect(worktree.disabled).toBe(true);
    expect(newBranch.getAttribute("aria-checked")).toBe("false");
    expect(newBranch.disabled).toBe(true);
    expect(
      (screen.getByTestId("create-agent-base-branch") as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(
      (screen.getByTestId("create-agent-worktree-branch") as HTMLInputElement)
        .disabled
    ).toBe(true);
  });

  it("uses saved values when the cwd is a git repo", () => {
    render(<WorktreeSection {...defaultProps} />);

    const worktree = checkbox("create-agent-worktree");
    const newBranch = checkbox("create-agent-new-branch");

    expect(worktree.getAttribute("aria-checked")).toBe("true");
    expect(worktree.disabled).toBe(false);
    expect(newBranch.getAttribute("aria-checked")).toBe("true");
    expect(newBranch.disabled).toBe(false);
    expect(
      (screen.getByTestId("create-agent-base-branch") as HTMLButtonElement)
        .disabled
    ).toBe(false);
    expect(
      (screen.getByTestId("create-agent-worktree-branch") as HTMLInputElement)
        .disabled
    ).toBe(false);
  });

  it("renders branch controls unchecked and disabled when worktrees are off", () => {
    render(<WorktreeSection {...defaultProps} useWorktree={false} />);

    const worktree = checkbox("create-agent-worktree");
    const newBranch = checkbox("create-agent-new-branch");

    expect(worktree.getAttribute("aria-checked")).toBe("false");
    expect(worktree.disabled).toBe(false);
    expect(newBranch.getAttribute("aria-checked")).toBe("false");
    expect(newBranch.disabled).toBe(true);
    expect(
      (screen.getByTestId("create-agent-base-branch") as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(
      (screen.getByTestId("create-agent-worktree-branch") as HTMLInputElement)
        .disabled
    ).toBe(true);
  });
});
