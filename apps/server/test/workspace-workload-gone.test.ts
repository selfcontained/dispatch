import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { workspaceWorkload } from "../../../packages/runner/src/workload/agents/checkout-worker.js";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "workload-gone-")));
});
afterEach(async () => {
  await chmod(root, 0o755).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

it("is true only when nothing is at the path", async () => {
  const folder = join(root, "worktree");
  await mkdir(folder);
  expect(await workspaceWorkload.gone(folder)).toBe(false);
  await rm(folder, { recursive: true });
  expect(await workspaceWorkload.gone(folder)).toBe(true);
});

it("counts a dangling link as something there (lstat, never followed)", async () => {
  const link = join(root, "link");
  await symlink(join(root, "nowhere"), link);
  expect(await workspaceWorkload.gone(link)).toBe(false);
});

it("throws for a path it cannot read: unreadable is not gone", async () => {
  if (process.getuid?.() === 0) return; // root reads any folder
  const folder = join(root, "worktree");
  await mkdir(folder);
  await chmod(root, 0o000);
  await expect(workspaceWorkload.gone(folder)).rejects.toMatchObject({
    code: "EACCES",
  });
});
