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

import {
  WORKTREE_LOCAL_CONFIG_FILES,
  assertTopLevelFileName,
  copyLocalConfigFiles,
} from "../src/agents/worktree-local-config.js";

let tempRoot: string;
let sourceRoot: string;
let worktreePath: string;

beforeEach(async () => {
  // A path with a space and an apostrophe — the same string is shell-quoted
  // into the tmux setup script, so it must survive both launch paths.
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "local-config-test-"));
  sourceRoot = path.join(tempRoot, "it's a repo");
  worktreePath = path.join(tempRoot, "wt");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(worktreePath, { recursive: true });
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const writeSource = (name: string, contents = "x\n") =>
  writeFile(path.join(sourceRoot, name), contents);

describe("WORKTREE_LOCAL_CONFIG_FILES", () => {
  it("still covers the original .env behaviour", () => {
    expect(WORKTREE_LOCAL_CONFIG_FILES).toContain(".env");
  });

  it("carries no file that copying alone would not actually fix", () => {
    // direnv will not load a copied .envrc until the new worktree is
    // approved, and approving it automatically would run repo code.
    expect(WORKTREE_LOCAL_CONFIG_FILES).not.toContain(".envrc");
  });

  it("carries no file that grants the launched agent new capabilities", () => {
    // A permission allowlist is not config: copying one would widen what a
    // `fullAccess: false` launch can do without saying so.
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
  it("copies every listed file that exists", async () => {
    await writeSource(".env", "FOO=bar\n");
    await writeSource(".dev.vars", "CF=1\n");
    await writeSource("terraform.tfvars", 'region="us"\n');

    await expect(
      copyLocalConfigFiles(sourceRoot, worktreePath)
    ).resolves.toEqual([".env", ".dev.vars", "terraform.tfvars"]);
    await expect(
      readFile(path.join(worktreePath, ".dev.vars"), "utf-8")
    ).resolves.toBe("CF=1\n");
  });

  it("does not copy conventionally-committed neighbours", async () => {
    for (const name of [".env.example", ".env.sample", ".env.production"]) {
      await writeSource(name);
    }
    await expect(
      copyLocalConfigFiles(sourceRoot, worktreePath)
    ).resolves.toEqual([]);
  });

  it("ignores a directory that happens to share a listed name", async () => {
    await mkdir(path.join(sourceRoot, ".env"), { recursive: true });
    await expect(
      copyLocalConfigFiles(sourceRoot, worktreePath)
    ).resolves.toEqual([]);
  });

  it("never overwrites a file the checkout already produced", async () => {
    // A repo that commits .npmrc: the worktree's checked-out revision wins
    // over the source checkout's (possibly dirty, possibly other-branch) copy.
    await writeSource(".npmrc", "FROM_SOURCE\n");
    await writeFile(path.join(worktreePath, ".npmrc"), "FROM_GIT\n");

    await expect(
      copyLocalConfigFiles(sourceRoot, worktreePath)
    ).resolves.toEqual([]);
    await expect(
      readFile(path.join(worktreePath, ".npmrc"), "utf-8")
    ).resolves.toBe("FROM_GIT\n");
  });

  it("does not follow a dangling destination symlink out of the worktree", async () => {
    // A dangling link passes an existence check but `copyFile` would follow
    // it, turning every name into a write primitive.
    const outside = path.join(tempRoot, "outside");
    await mkdir(outside, { recursive: true });
    await writeSource(".env", "SECRET=1\n");
    await symlink(path.join(outside, "pwned"), path.join(worktreePath, ".env"));

    await expect(
      copyLocalConfigFiles(sourceRoot, worktreePath)
    ).resolves.toEqual([]);
    await expect(readFile(path.join(outside, "pwned"))).rejects.toThrow();
  });

  it("refuses a source that is a symlink", async () => {
    // Otherwise a checkout containing `.env -> ~/.ssh/id_rsa` would copy
    // that file somewhere the repo and the agent can read it.
    const secret = path.join(tempRoot, "id_rsa");
    await writeFile(secret, "PRIVATE KEY\n");
    await symlink(secret, path.join(sourceRoot, ".env"));

    await expect(
      copyLocalConfigFiles(sourceRoot, worktreePath)
    ).resolves.toEqual([]);
    await expect(readFile(path.join(worktreePath, ".env"))).rejects.toThrow();
  });

  it("creates the destination exclusively, closing the check-then-copy race", async () => {
    // The interleaving that matters: nothing at the destination when the
    // copy starts, a symlink installed before the write lands. An
    // existence test cannot cover this; O_CREAT|O_EXCL can.
    const outside = path.join(tempRoot, "outside");
    await mkdir(outside, { recursive: true });
    const victim = path.join(outside, "victim");
    await writeFile(victim, "ORIGINAL\n");
    await writeSource(".env", "SECRET\n");
    await symlink(victim, path.join(worktreePath, ".env"));

    await expect(
      copyLocalConfigFiles(sourceRoot, worktreePath)
    ).resolves.toEqual([]);
    await expect(readFile(victim, "utf-8")).resolves.toBe("ORIGINAL\n");
  });

  it("lands copies at 0600 rather than inheriting a loose source mode", async () => {
    await writeSource(".env", "SECRET=1\n");
    await chmod(path.join(sourceRoot, ".env"), 0o644);

    await expect(
      copyLocalConfigFiles(sourceRoot, worktreePath)
    ).resolves.toEqual([".env"]);
    const stats = await stat(path.join(worktreePath, ".env"));
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("is a no-op when the source repo has none of them", async () => {
    await expect(
      copyLocalConfigFiles(sourceRoot, worktreePath)
    ).resolves.toEqual([]);
  });

  it("is a no-op when the worktree path does not exist", async () => {
    await writeSource(".env");
    await expect(
      copyLocalConfigFiles(sourceRoot, path.join(tempRoot, "nope"))
    ).resolves.toEqual([]);
  });
});
