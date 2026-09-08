import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  listHarnessPaths,
  resolvePathQuery,
} from "../src/agents/harness/paths.js";

let root: string;
let cwd: string;
let home: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "dsh-paths-"));
  cwd = path.join(root, "repo");
  home = path.join(root, "home");
  await mkdir(path.join(cwd, "apps", "web"), { recursive: true });
  await mkdir(path.join(cwd, "apps", "server"), { recursive: true });
  await mkdir(path.join(cwd, "docs"), { recursive: true });
  await mkdir(path.join(cwd, ".dispatch"), { recursive: true });
  await writeFile(path.join(cwd, "README.md"), "# hi\n");
  await writeFile(path.join(cwd, "apps", "notes.txt"), "n\n");
  await writeFile(path.join(cwd, ".env"), "x=1\n");
  await symlink(path.join(cwd, "docs"), path.join(cwd, "docs-link"));
  await mkdir(path.join(home, "src"), { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolvePathQuery", () => {
  it("resolves relative, home, and absolute prefixes", () => {
    expect(resolvePathQuery("ap", { cwd, home })).toEqual({
      dir: cwd,
      typedDir: "",
      segment: "ap",
    });
    expect(resolvePathQuery("apps/we", { cwd, home })).toEqual({
      dir: path.join(cwd, "apps/"),
      typedDir: "apps/",
      segment: "we",
    });
    expect(resolvePathQuery("~/sr", { cwd, home })).toEqual({
      dir: path.join(home, ""),
      typedDir: "~/",
      segment: "sr",
    });
    expect(resolvePathQuery("/tmp/x", { cwd, home })).toEqual({
      dir: "/tmp/",
      typedDir: "/tmp/",
      segment: "x",
    });
  });

  it("refuses NUL bytes and over-long queries", () => {
    expect(resolvePathQuery("a\0b", { cwd, home })).toBeNull();
    expect(resolvePathQuery("x".repeat(2000), { cwd, home })).toBeNull();
  });
});

describe("listHarnessPaths", () => {
  it("lists the working tree, directories first, hidden entries only when asked", async () => {
    expect(await listHarnessPaths("", { cwd, home })).toEqual([
      { path: "apps", kind: "dir" },
      { path: "docs", kind: "dir" },
      { path: "docs-link", kind: "dir" },
      { path: "README.md", kind: "file" },
    ]);
    expect(await listHarnessPaths(".", { cwd, home })).toEqual([
      { path: ".dispatch", kind: "dir" },
      { path: ".env", kind: "file" },
    ]);
  });

  it("matches the last segment case-insensitively and keeps the typed prefix", async () => {
    expect(await listHarnessPaths("apps/S", { cwd, home })).toEqual([
      { path: "apps/server", kind: "dir" },
    ]);
    expect(await listHarnessPaths("apps/", { cwd, home })).toEqual([
      { path: "apps/server", kind: "dir" },
      { path: "apps/web", kind: "dir" },
      { path: "apps/notes.txt", kind: "file" },
    ]);
    expect(await listHarnessPaths("~/s", { cwd, home })).toEqual([
      { path: "~/src", kind: "dir" },
    ]);
    expect(await listHarnessPaths("~", { cwd, home })).toEqual([
      { path: "~", kind: "dir" },
    ]);
  });

  it("keeps directories when many files sort ahead of them", async () => {
    const big = path.join(root, "big");
    await mkdir(big);
    for (let i = 0; i < 120; i += 1) {
      await writeFile(path.join(big, `a${String(i).padStart(3, "0")}.txt`), "");
    }
    for (let i = 0; i < 5; i += 1) await mkdir(path.join(big, `zdir${i}`));
    const out = await listHarnessPaths("big/", { cwd: root });
    expect(out).toHaveLength(50);
    expect(out.slice(0, 5).map((p) => p.path)).toEqual([
      "big/zdir0",
      "big/zdir1",
      "big/zdir2",
      "big/zdir3",
      "big/zdir4",
    ]);
    expect(out.slice(5).every((p) => p.kind === "file")).toBe(true);
  });

  it("answers nothing for a directory that does not exist", async () => {
    expect(await listHarnessPaths("nope/x", { cwd, home })).toEqual([]);
    expect(await listHarnessPaths("a\0b", { cwd, home })).toEqual([]);
  });
});
