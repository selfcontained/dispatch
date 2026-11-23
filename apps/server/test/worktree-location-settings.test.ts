import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertWorktreeDirectoryUsable,
  getWorktreePlacement,
  resolveWorktreePathOverride,
  WorktreeDirectoryError,
} from "../src/worktree-location-settings.js";

function fakePool(settings: Record<string, string>): Pool {
  return {
    query: async (_sql: string, params: string[]) => {
      const value = settings[params[0]];
      return { rows: value === undefined ? [] : [{ value }] };
    },
  } as unknown as Pool;
}

describe("getWorktreePlacement", () => {
  it("defaults to sibling", async () => {
    expect(await getWorktreePlacement(fakePool({}))).toEqual({
      worktreeLocation: "sibling",
    });
  });

  it("returns the folder with directory placement", async () => {
    expect(
      await getWorktreePlacement(
        fakePool({
          worktree_location: "directory",
          worktree_directory: "/Volumes/storage/worktrees",
        })
      )
    ).toEqual({
      worktreeLocation: "directory",
      worktreeDirectory: "/Volumes/storage/worktrees",
    });
  });

  it("reads directory placement without a folder as sibling", async () => {
    expect(
      await getWorktreePlacement(fakePool({ worktree_location: "directory" }))
    ).toEqual({ worktreeLocation: "sibling" });
  });

  it("does not pass a stored folder to other placements", async () => {
    expect(
      await getWorktreePlacement(
        fakePool({
          worktree_location: "nested",
          worktree_directory: "/Volumes/storage/worktrees",
        })
      )
    ).toEqual({ worktreeLocation: "nested" });
  });
});

describe("assertWorktreeDirectoryUsable", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "worktree-dir-"));
  });
  afterEach(async () => {
    await chmod(root, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  it("accepts an existing writable folder", async () => {
    expect(await assertWorktreeDirectoryUsable(`${root}/`)).toBe(
      path.resolve(root)
    );
  });

  it("rejects a relative path", async () => {
    await expect(assertWorktreeDirectoryUsable("worktrees")).rejects.toThrow(
      "must be an absolute path"
    );
  });

  // An unmounted drive looks like this: the mount point folder is gone.
  it("rejects a missing folder without creating it", async () => {
    const missing = path.join(root, "unmounted", "worktrees");
    const error = await assertWorktreeDirectoryUsable(missing).catch(
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(WorktreeDirectoryError);
    expect((error as WorktreeDirectoryError).statusCode).toBe(409);
    expect((error as Error).message).toContain("does not exist");
    expect((error as Error).message).toContain("Connect the drive");
    await expect(stat(path.join(root, "unmounted"))).rejects.toThrow();
  });

  it("rejects a file", async () => {
    const file = path.join(root, "file");
    await writeFile(file, "");
    await expect(assertWorktreeDirectoryUsable(file)).rejects.toThrow(
      "not a directory"
    );
  });

  it.skipIf(process.getuid?.() === 0)(
    "rejects a read-only folder",
    async () => {
      await chmod(root, 0o500);
      await expect(assertWorktreeDirectoryUsable(root)).rejects.toThrow(
        "not writable"
      );
    }
  );
});

describe("resolveWorktreePathOverride", () => {
  const target = {
    originalCwd: "/repo/dispatch",
    worktreeBranchName: "agt_1/fix-it",
    createNewBranch: true,
  };

  it("leaves sibling placement to createGitWorktree", async () => {
    expect(
      await resolveWorktreePathOverride({ worktreeLocation: "sibling" }, target)
    ).toBeUndefined();
  });

  it("nests under .dispatch/worktrees", async () => {
    expect(
      await resolveWorktreePathOverride({ worktreeLocation: "nested" }, target)
    ).toBe("/repo/dispatch/.dispatch/worktrees/agt-1-fix-it");
  });

  it("puts a repo-branch folder in the chosen directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "worktree-dir-"));
    try {
      expect(
        await resolveWorktreePathOverride(
          { worktreeLocation: "directory", worktreeDirectory: root },
          target
        )
      ).toBe(path.join(root, "dispatch-agt-1-fix-it"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a missing directory instead of falling back", async () => {
    await expect(
      resolveWorktreePathOverride(
        {
          worktreeLocation: "directory",
          worktreeDirectory: "/Volumes/dispatch-test-absent-drive/worktrees",
        },
        target
      )
    ).rejects.toBeInstanceOf(WorktreeDirectoryError);
  });
});
