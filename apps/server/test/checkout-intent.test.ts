import type { RepositoryCheckout } from "@dispatch/runner-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveCheckoutIntent,
  resolveLocalCheckout,
  toLocalWorktreeRequest,
  toRunnerCheckout,
  type CheckoutIntent,
} from "../src/agents/checkout-intent.js";
import { resolveCurrentBranch } from "../src/shared/git/git-context.js";
import { detectDefaultBranch } from "../src/agents/workspace-target.js";

vi.mock("../src/agents/workspace-target.js", () => ({
  detectDefaultBranch: vi.fn(),
}));
vi.mock("../src/shared/git/git-context.js", () => ({
  resolveCurrentBranch: vi.fn(),
}));

const context = { id: "agt_example", name: " A new agent! " };

describe("checkout intent", () => {
  beforeEach(() => {
    vi.mocked(detectDefaultBranch).mockResolvedValue("trunk");
    vi.mocked(resolveCurrentBranch).mockResolvedValue("current");
  });

  it.each<[string, CheckoutIntent, string, string, RepositoryCheckout]>([
    [
      "named new branch with an explicit base",
      { worktreeBranch: " origin/topic ", baseBranch: " origin/release " },
      "origin/topic",
      "release",
      { kind: "new", branch: "origin/topic", base: "release" },
    ],
    [
      "automatic branch with an explicit base",
      { baseBranch: "main" },
      "agt_example/a-new-agent",
      "main",
      { kind: "new", branch: "agt_example/a-new-agent", base: "main" },
    ],
    [
      "blank refs",
      { worktreeBranch: " ", baseBranch: " " },
      "agt_example/a-new-agent",
      "trunk",
      { kind: "new", branch: "agt_example/a-new-agent" },
    ],
    [
      "existing branch with an unused new-branch name",
      {
        createNewBranch: false,
        worktreeBranch: "ignored",
        baseBranch: "origin/release",
      },
      "release",
      "release",
      { kind: "branch", branch: "release", allowDefault: true },
    ],
    [
      "existing default branch",
      { createNewBranch: false },
      "trunk",
      "trunk",
      { kind: "default" },
    ],
  ])(
    "preserves both placements for %s",
    async (_, input, branch, base, runner) => {
      const { checkout } = resolveCheckoutIntent(input, context);
      if (!checkout) throw new Error("Expected a worktree intent");
      const request = toLocalWorktreeRequest(checkout, context.name, "nested");
      expect(request.location).toBe("nested");
      await expect(resolveLocalCheckout("/repo", request)).resolves.toEqual({
        branch,
        base,
      });
      expect(toRunnerCheckout(checkout)).toEqual(runner);
    }
  );

  it("preserves the native current-branch and main fallbacks", async () => {
    vi.mocked(detectDefaultBranch).mockResolvedValue(null);
    const { checkout } = resolveCheckoutIntent(
      { createNewBranch: false },
      context
    );
    if (!checkout) throw new Error("Expected a worktree intent");
    const request = toLocalWorktreeRequest(checkout, context.name);
    await expect(resolveLocalCheckout("/repo", request)).resolves.toEqual({
      branch: "current",
      base: "current",
    });
    vi.mocked(resolveCurrentBranch).mockRejectedValueOnce(new Error("No HEAD"));
    await expect(resolveLocalCheckout("/repo", request)).resolves.toEqual({
      branch: "main",
      base: "main",
    });
  });

  it("preserves the recorded base without a worktree", () => {
    expect(
      resolveCheckoutIntent(
        { useWorktree: false, baseBranch: "origin/release" },
        context
      )
    ).toEqual({ normalizedBaseBranch: "release", checkout: null });
    expect(() =>
      resolveCheckoutIntent(
        { useWorktree: false, worktreeBranch: "bad ref" },
        context
      )
    ).toThrow("worktreeBranch");
  });
});
