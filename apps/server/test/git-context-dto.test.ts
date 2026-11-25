import type { GitContext } from "@dispatch/runner-protocol/git-context";
import { expect, expectTypeOf, it } from "vitest";
import type { AgentGitContext as SharedContext } from "@dispatch/shared";
import type { AgentGitContext as AppContext } from "../src/agents/types.js";
import { gitContextFrom } from "../src/agents/git-context-value.js";

it("preserves checkout context fields and basename behavior", () => {
  for (const [worktreePath, worktreeName, isWorktree] of [
    ["/repo", "repo", false],
    ["/repo/worktree", "worktree", true],
    ["/repo/worktree/", "worktree", true],
    ["/", "", true],
  ] as const) {
    expect(
      gitContextFrom({
        repoRoot: "/repo",
        branch: "feature",
        worktreePath,
        repoIconPath: null,
      })
    ).toEqual({
      repoRoot: "/repo",
      branch: "feature",
      worktreePath,
      worktreeName,
      isWorktree,
      repoIconPath: null,
    });
  }
});

it("keeps the app and shared context types identical", () => {
  expectTypeOf<AppContext>().toEqualTypeOf<SharedContext>();
  expectTypeOf<AppContext>().toEqualTypeOf<GitContext>();
  expectTypeOf<SharedContext>().toEqualTypeOf<{
    repoRoot: string;
    branch: string;
    worktreePath: string;
    worktreeName: string;
    isWorktree: boolean;
    repoIconPath?: string | null;
  }>();
});
