import { afterEach, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  realpath,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  buildWorkspaceFileIndex,
  createWorkspaceFileIndexer,
} from "../src/files/workspace-file-index.js";

const roots: string[] = [];
async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "dispatch-index-"))
  );
  roots.push(root);
  await mkdir(path.join(root, "nested"));
  await writeFile(
    path.join(root, "nested/hello.ts"),
    "contents are irrelevant"
  );
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

test("Git index finds unopened nested files and respects ignored paths", async () => {
  const root = await fixture();
  await promisify(execFile)("git", ["init", root]);
  await writeFile(path.join(root, ".gitignore"), "ignored/\n");
  await mkdir(path.join(root, "ignored"));
  await writeFile(path.join(root, "ignored/secret.ts"), "excluded");
  const result = await buildWorkspaceFileIndex(root);
  expect(result.source).toBe("git");
  expect(result.paths).toContain("nested/hello.ts");
  expect(result.paths).not.toContain("ignored/secret.ts");
  expect(result.truncated).toBe(false);
});

test("folder fallback excludes dependencies and symlink directories", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "node_modules/dependency.ts"), "");
  await symlink(path.join(root, "nested"), path.join(root, "linked"));
  const result = await buildWorkspaceFileIndex(root);
  expect(result).toEqual({
    paths: ["nested/hello.ts"],
    truncated: false,
    source: "folders",
  });
});

test("a cached snapshot avoids rescanning until explicit refresh", async () => {
  const root = await fixture();
  const index = createWorkspaceFileIndexer();
  const first = index(root, "initial");
  expect(index(root, "initial")).toBe(first);
  await first;
  await writeFile(path.join(root, "added.ts"), "");
  expect((await index(root, "initial")).paths).not.toContain("added.ts");
  expect((await index(root, "refresh")).paths).toContain("added.ts");
});
