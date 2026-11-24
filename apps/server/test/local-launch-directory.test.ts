/*
 * Where a local launch starts (`resolveLaunchDirectory`), pinned before it
 * moves behind the runner interface. Main's `validateWorkingDirectory`
 * expands `~`, requires an absolute path to a directory, and answers with
 * these messages and statuses; the branch adds the canonical path and the
 * Git probe main ran at launch.
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveLaunchDirectory } from "../src/agents/workspace.js";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "launch-dir-")));
const repo = path.join(root, "repo");
const sub = path.join(repo, "src");
const plain = path.join(root, "plain");
mkdirSync(sub, { recursive: true });
mkdirSync(plain);
writeFileSync(path.join(root, "file.txt"), "");
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
git("init", "-q", "-b", "main");
git(
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
  "commit",
  "-q",
  "--allow-empty",
  "-m",
  "init"
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("local launch directory", () => {
  it("keeps a repository root and probes its Git context", async () => {
    const resolved = await resolveLaunchDirectory(repo);
    expect(resolved).toMatchObject({ cwd: repo, canonicalPath: repo });
    expect(resolved.git).toMatchObject({
      status: "ok",
      value: { repoRoot: repo, worktreePath: repo, branch: "main" },
    });
  });

  it("keeps a subdirectory as chosen; Git names its repository", async () => {
    const resolved = await resolveLaunchDirectory(sub);
    expect(resolved).toMatchObject({ cwd: sub, canonicalPath: sub });
    expect(resolved.git).toMatchObject({
      status: "ok",
      value: { repoRoot: repo },
    });
  });

  it("answers a plain folder with no Git context", async () => {
    expect(await resolveLaunchDirectory(plain)).toEqual({
      cwd: plain,
      canonicalPath: plain,
      git: { status: "ok", value: null },
      origin: null,
    });
  });

  it("reports a repository's HTTPS origin beside, not inside, its Git context", async () => {
    git("remote", "add", "origin", "git@github.com:fixture/example.git");
    try {
      const resolved = await resolveLaunchDirectory(sub);
      expect(resolved.origin).toBe("https://github.com/fixture/example.git");
      expect(resolved.git).toMatchObject({ status: "ok" });
      expect(
        resolved.git.status === "ok" && resolved.git.value
          ? "origin" in resolved.git.value
          : null
      ).toBe(false);
    } finally {
      git("remote", "remove", "origin");
    }
  });

  it("keeps the spelling it was given and resolves a link canonically", async () => {
    const link = path.join(root, "link");
    execFileSync("ln", ["-s", repo, link]);
    expect(await resolveLaunchDirectory(link)).toMatchObject({
      cwd: link,
      canonicalPath: repo,
    });
  });

  it("expands ~ from HOME as main does", async () => {
    const home = process.env.HOME;
    process.env.HOME = plain;
    try {
      expect(await resolveLaunchDirectory("~")).toMatchObject({ cwd: plain });
      // `path.join` drops the trailing separator, as in main.
      expect(await resolveLaunchDirectory("~/")).toMatchObject({ cwd: plain });
    } finally {
      process.env.HOME = home;
    }
  });

  it("refuses with main's messages and status 400", async () => {
    for (const [cwd, message] of [
      ["relative/dir", "Working directory must be an absolute path."],
      [
        path.join(root, "missing"),
        "Working directory does not exist or is not a directory.",
      ],
      [
        path.join(root, "file.txt"),
        "Working directory does not exist or is not a directory.",
      ],
    ] as const)
      await expect(resolveLaunchDirectory(cwd)).rejects.toMatchObject({
        message,
        statusCode: 400,
      });
  });
});
