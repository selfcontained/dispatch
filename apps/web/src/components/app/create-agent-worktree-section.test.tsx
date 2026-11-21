// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render as renderWithTestingLibrary,
  screen,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorktreeSection } from "./create-agent-worktree-section";

vi.mock("@/lib/api", () => ({
  api: vi.fn(() => Promise.resolve({ branches: ["main", "feature/x"] })),
}));

// cmdk uses ResizeObserver and scrollIntoView, which jsdom lacks.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  ResizeObserverStub;
Element.prototype.scrollIntoView = () => {};

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

function render(ui: ReactElement) {
  const client = new QueryClient();
  return renderWithTestingLibrary(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

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
  it("locks the worktree on when it is not optional with the same helper text", () => {
    const { container } = render(
      <WorktreeSection {...defaultProps} worktreeOptional={false} />
    );
    expect(checkbox("create-agent-worktree").disabled).toBe(true);
    expect(checkbox("create-agent-new-branch").disabled).toBe(false);
    const lockedText = container.textContent;
    cleanup();
    const optional = render(<WorktreeSection {...defaultProps} />);
    expect(checkbox("create-agent-worktree").disabled).toBe(false);
    expect(optional.container.textContent).toBe(lockedText);
    expect(screen.queryByText(/Archiving removes this worktree/)).toBeNull();
  });

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

  it("closes an open branch dropdown and makes controls inert when worktrees collapse", () => {
    const { rerender } = render(<WorktreeSection {...defaultProps} />);

    fireEvent.click(baseBranch());
    expect(baseBranch().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByPlaceholderText("Search branches...")).toBeTruthy();

    rerender(<WorktreeSection {...defaultProps} useWorktree={false} />);

    expect(baseBranch().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByPlaceholderText("Search branches...")).toBeNull();
    expect(baseBranch().closest("[aria-hidden]")?.hasAttribute("inert")).toBe(
      true
    );

    rerender(<WorktreeSection {...defaultProps} />);

    expect(baseBranch().getAttribute("aria-expanded")).toBe("false");
    expect(baseBranch().closest("[aria-hidden]")?.hasAttribute("inert")).toBe(
      false
    );
  });

  it("labels the picker for the branch it will check out", () => {
    const { rerender } = render(<WorktreeSection {...defaultProps} />);
    expect(baseBranch().getAttribute("aria-label")).toBe("Starting branch");
    rerender(<WorktreeSection {...defaultProps} createNewBranch={false} />);
    expect(baseBranch().getAttribute("aria-label")).toBe("Existing branch");
    expect(screen.getByText("Existing branch")).toBeTruthy();
  });
});
