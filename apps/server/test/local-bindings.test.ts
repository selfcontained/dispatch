/*
 * The app half of the one-time binding import: agent row → the facts sent to
 * the local runner. The worktree claim must be exactly what main's archive
 * removes (`worktree_path`, nothing else); the runner then confirms it with
 * Git. One assertion per truth-table row, so a flip fails.
 */
import { describe, expect, it } from "vitest";
import {
  bindingFromRow,
  type LocalBindingRow,
} from "../src/runners/local-bindings.js";

const row = (over: Partial<LocalBindingRow>): LocalBindingRow => ({
  id: "s1",
  cwd: "/repo",
  worktreePath: null,
  worktreeBranch: null,
  baseBranch: null,
  workspacePath: null,
  ...over,
});

describe("bindingFromRow (truth table, app side)", () => {
  it("main-created worktree: claims the worktree with its recorded branch and base", () => {
    expect(
      bindingFromRow(
        row({
          cwd: "/repo/.dispatch/worktrees/feat",
          worktreePath: "/repo/.dispatch/worktrees/feat",
          worktreeBranch: "feat",
          baseBranch: "main",
        })
      )
    ).toEqual({
      session: "s1",
      path: "/repo/.dispatch/worktrees/feat",
      currentPath: null,
      worktree: {
        path: "/repo/.dispatch/worktrees/feat",
        branch: "feat",
        base: "main",
      },
    });
  });

  it("plain folder: no worktree claim", () => {
    expect(bindingFromRow(row({ cwd: "/home/me/notes" }))?.worktree).toBeNull();
  });

  it("a base branch alone is not a claim", () => {
    expect(
      bindingFromRow(row({ baseBranch: "main", worktreeBranch: "feat" }))
        ?.worktree
    ).toBeNull();
  });

  it("moved workspace: the launch worktree stays the claim; the move is only a current path", () => {
    const binding = bindingFromRow(
      row({
        cwd: "/wt/feat",
        worktreePath: "/wt/feat",
        worktreeBranch: "feat",
        workspacePath: "/home/me/other",
      })
    );
    expect(binding?.worktree?.path).toBe("/wt/feat");
    expect(binding?.currentPath).toBe("/home/me/other");
  });

  it("moved workspace on a plain folder: never claimed", () => {
    const binding = bindingFromRow(
      row({ cwd: "/home/me/notes", workspacePath: "/wt/someone-elses" })
    );
    expect(binding?.worktree).toBeNull();
    expect(binding?.currentPath).toBe("/wt/someone-elses");
  });

  it("workspace equal to cwd is not a move", () => {
    expect(
      bindingFromRow(row({ cwd: "/a", workspacePath: "/a" }))?.currentPath
    ).toBeNull();
  });

  it("changed branch: the row's recorded branch is sent, not a live one", () => {
    expect(
      bindingFromRow(
        row({ cwd: "/wt/x", worktreePath: "/wt/x", worktreeBranch: "created" })
      )?.worktree?.branch
    ).toBe("created");
  });

  it("worktree path differing from cwd: main removes worktree_path, so that is the claim", () => {
    expect(
      bindingFromRow(row({ cwd: "/somewhere", worktreePath: "/wt/x" }))
        ?.worktree?.path
    ).toBe("/wt/x");
  });

  it("blank worktree path: no claim", () => {
    expect(
      bindingFromRow(row({ worktreePath: "  ", worktreeBranch: "feat" }))
        ?.worktree
    ).toBeNull();
  });

  it("no cwd, or a runner locator an older build left: absent", () => {
    expect(bindingFromRow(row({ cwd: null }))).toBeNull();
    expect(bindingFromRow(row({ cwd: "" }))).toBeNull();
    expect(
      bindingFromRow(row({ cwd: "runner://rnr_example/@session" }))
    ).toBeNull();
  });
});
