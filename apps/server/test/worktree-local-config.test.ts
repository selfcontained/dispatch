import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCommand } from "../src/shared/lib/run-command.js";

import {
  WORKTREE_LOCAL_CONFIG_FILES,
  assertTopLevelFileName,
  copyLocalConfigFiles,
} from "../src/agents/worktree-local-config.js";

let tempRoot: string;
let sourceRoot: string;
let worktreePath: string;
let outside: string;

beforeEach(async () => {
  // A path with a space and an apostrophe — the same string is shell-quoted
  // into the tmux setup script, so it must survive both launch paths.
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "local-config-test-"));
  sourceRoot = path.join(tempRoot, "it's a repo");
  worktreePath = path.join(tempRoot, "wt");
  outside = path.join(tempRoot, "outside");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(worktreePath, { recursive: true });
  await mkdir(outside, { recursive: true });
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const src = (name: string) => path.join(sourceRoot, name);
const dest = (name: string) => path.join(worktreePath, name);
const writeSource = (name: string, contents = "x\n") =>
  writeFile(src(name), contents);
const copy = () => copyLocalConfigFiles(sourceRoot, worktreePath);
const git = async (cwd: string, ...args: string[]) =>
  (await runCommand("git", ["-C", cwd, ...args])).stdout;

describe("WORKTREE_LOCAL_CONFIG_FILES", () => {
  it("keeps .env and stays clear of the names deliberately rejected", () => {
    expect(WORKTREE_LOCAL_CONFIG_FILES).toContain(".env");
    // Copying .envrc fixes nothing until direnv approves the new worktree,
    // and a permission allowlist would widen what a restricted launch can do.
    expect(WORKTREE_LOCAL_CONFIG_FILES).not.toContain(".envrc");
    expect(WORKTREE_LOCAL_CONFIG_FILES).not.toContain(
      ".claude/settings.local.json"
    );
  });
});

describe("assertTopLevelFileName", () => {
  it("accepts every name the module ships", () => {
    for (const name of WORKTREE_LOCAL_CONFIG_FILES) {
      expect(assertTopLevelFileName(name)).toBe(name);
    }
  });

  it.each([
    // Anything bash would expand but `fs` would look up literally (or the
    // reverse) is how the two launch paths drift apart.
    ".env.*.local",
    "*.auto.tfvars",
    "config/master.key",
    "config/",
    "/etc/passwd",
    "../outside/.env",
    "",
    ".",
    "..",
    ".env;rm -rf /",
    ".env$(id)",
    ".env with space",
  ])("rejects %j", (name) => {
    expect(() => assertTopLevelFileName(name)).toThrow(
      /Unsafe worktree local-config filename/
    );
  });
});

describe("copyLocalConfigFiles", () => {
  it("copies the listed files that exist, at 0600, and nothing else", async () => {
    await writeSource(".env", "FOO=bar\n");
    await writeSource(".dev.vars", "CF=1\n");
    await chmod(src(".env"), 0o644);
    // Committed neighbours are already in the worktree via the checkout,
    // and a directory sharing a listed name is not a config file.
    for (const name of [".env.example", ".env.sample", ".env.production"]) {
      await writeSource(name);
    }
    await mkdir(src("terraform.tfvars"));

    await expect(copy()).resolves.toMatchObject({
      copied: [".env", ".dev.vars"],
    });
    await expect(readFile(dest(".dev.vars"), "utf-8")).resolves.toBe("CF=1\n");
    expect((await stat(dest(".env"))).mode & 0o777).toBe(0o600);
  });

  it("leaves every kind of existing destination untouched", async () => {
    // One listed name per destination state. A regular file is what a repo
    // that commits the name produces; the two symlinks are write primitives
    // if followed, and the dangling one is invisible to an existence test.
    await writeSource(".npmrc", "FROM_SOURCE\n");
    await writeSource(".env", "FROM_SOURCE\n");
    await writeSource(".dev.vars", "FROM_SOURCE\n");
    const live = path.join(outside, "live");
    await writeFile(live, "ORIGINAL\n");
    await writeFile(dest(".npmrc"), "FROM_GIT\n");
    await symlink(live, dest(".env"));
    await symlink(path.join(outside, "dangling"), dest(".dev.vars"));

    await expect(copy()).resolves.toMatchObject({ copied: [] });
    await expect(readFile(dest(".npmrc"), "utf-8")).resolves.toBe("FROM_GIT\n");
    await expect(readFile(live, "utf-8")).resolves.toBe("ORIGINAL\n");
    await expect(readFile(path.join(outside, "dangling"))).rejects.toThrow();
  });

  it("refuses a symlinked source while still copying its neighbours", async () => {
    // Otherwise a checkout containing `.env -> ~/.ssh/id_rsa` copies that
    // file somewhere the repo can read it. `O_NOFOLLOW` refuses on the same
    // open the copy reads from, so there is no path test to race.
    const secret = path.join(outside, "id_rsa");
    await writeFile(secret, "PRIVATE KEY\n");
    await symlink(secret, src(".env"));
    await writeSource(".dev.vars", "CF=1\n");

    await expect(copy()).resolves.toEqual({
      copied: [".dev.vars"],
      // Reported, not silent: otherwise the symptom is the confusing
      // missing-config failure this module exists to remove.
      skipped: [{ name: ".env", reason: "symlink" }],
    });
    await expect(readFile(dest(".env"))).rejects.toThrow();
  });

  it("is a no-op with nothing to copy, or nowhere to copy to", async () => {
    await expect(copy()).resolves.toMatchObject({ copied: [] });

    await writeSource(".env");
    await expect(
      copyLocalConfigFiles(sourceRoot, path.join(tempRoot, "nope"))
    ).resolves.toMatchObject({ copied: [] });
  });

  it("copies only what git ignores in the worktree", async () => {
    // A copied file git does not ignore shows in `git status --porcelain`,
    // which makes the agent read dirty, renders it into the agent diff,
    // stops auto-cleanup removing the worktree, and blocks a non-forced
    // `git worktree remove`.
    await git(worktreePath, "init", "-qb", "main");
    await git(worktreePath, "config", "user.email", "t@t");
    await git(worktreePath, "config", "user.name", "t");
    // Tracked, as it is in a real worktree — an untracked .gitignore would
    // itself dirty the status this test is checking.
    await writeFile(path.join(worktreePath, ".gitignore"), ".env\n");
    await git(worktreePath, "add", ".gitignore");
    await git(worktreePath, "commit", "-qm", "init");
    await writeSource(".env", "A=1\n");
    await writeSource(".npmrc", "//r/:_authToken=SECRET\n");

    await expect(copy()).resolves.toEqual({
      copied: [".env"],
      skipped: [{ name: ".npmrc", reason: "not-ignored" }],
    });

    const status = await git(worktreePath, "status", "--porcelain");
    expect(status).toBe("");
  });

  it("stays quiet about a name the repo commits despite ignoring it", async () => {
    // `check-ignore` is index-aware: a tracked path is never reported as
    // ignored, even with a matching .gitignore line. That file is already
    // in the worktree from the checkout, so warning about it every launch
    // would be noise about something that is already correct.
    await git(worktreePath, "init", "-qb", "main");
    await git(worktreePath, "config", "user.email", "t@t");
    await git(worktreePath, "config", "user.name", "t");
    await writeFile(path.join(worktreePath, ".gitignore"), ".env\n.npmrc\n");
    await writeFile(dest(".npmrc"), "FROM_GIT\n");
    await git(worktreePath, "add", "-f", ".gitignore", ".npmrc");
    await git(worktreePath, "commit", "-qm", "init");
    await writeSource(".npmrc", "FROM_SOURCE\n");
    await writeSource("local.settings.json", "{}\n");

    await expect(copy()).resolves.toEqual({
      copied: [],
      // Only the name that is genuinely absent and unignored is reported.
      skipped: [{ name: "local.settings.json", reason: "not-ignored" }],
    });
    await expect(readFile(dest(".npmrc"), "utf-8")).resolves.toBe("FROM_GIT\n");
  });
});
