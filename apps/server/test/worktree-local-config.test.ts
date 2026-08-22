import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  WORKTREE_LOCAL_CONFIG_PATTERNS,
  assertSafeLocalConfigPattern,
  copyLocalConfigFiles,
  resolveLocalConfigFiles,
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

async function writeSource(relativePath: string, contents = "x\n") {
  const target = path.join(sourceRoot, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

describe("WORKTREE_LOCAL_CONFIG_PATTERNS", () => {
  it("still covers the original .env behaviour", () => {
    expect(WORKTREE_LOCAL_CONFIG_PATTERNS).toContain(".env");
  });

  it("only wildcards the final path segment", () => {
    for (const pattern of WORKTREE_LOCAL_CONFIG_PATTERNS) {
      expect(path.dirname(pattern)).not.toContain("*");
      expect(pattern).not.toContain("..");
      expect(pattern.startsWith("/")).toBe(false);
    }
  });

  it("carries no file that grants the launched agent new capabilities", () => {
    // A permission allowlist is not config: copying one would widen what a
    // `fullAccess: false` launch can do without saying so.
    expect(WORKTREE_LOCAL_CONFIG_PATTERNS).not.toContain(
      ".claude/settings.local.json"
    );
  });
});

describe("assertSafeLocalConfigPattern", () => {
  it("accepts every pattern the module ships", () => {
    for (const pattern of WORKTREE_LOCAL_CONFIG_PATTERNS) {
      expect(assertSafeLocalConfigPattern(pattern)).toBe(pattern);
    }
  });

  it.each([
    // Bash would expand this across a directory; resolveLocalConfigFiles
    // would look for a literal `*` segment. Divergence between the two
    // launch paths is the whole failure mode this list exists to prevent.
    "config/*/secret",
    "config/",
    "/etc/passwd",
    "../outside/.env",
    "config/../../.env",
    "",
    ".",
    "..",
    // Shell metacharacters that would change meaning unquoted.
    ".env;rm -rf /",
    ".env$(id)",
    ".env`id`",
    ".env|tee",
    ".env with space",
  ])("rejects %j", (pattern) => {
    expect(() => assertSafeLocalConfigPattern(pattern)).toThrow(
      /Unsafe worktree local-config pattern/
    );
  });
});

describe("resolveLocalConfigFiles", () => {
  it("matches the local-override and ecosystem secret filenames", async () => {
    for (const name of [
      ".env",
      ".env.local",
      ".env.development.local",
      ".env.production.local",
      ".dev.vars",
      ".envrc",
      ".npmrc",
      "local.settings.json",
      "terraform.tfvars",
      "terraform.tfvars.json",
      "prod.auto.tfvars",
      "extra.auto.tfvars.json",
      "config/master.key",
      "config/credentials/production.key",
      ".streamlit/secrets.toml",
    ]) {
      await writeSource(name);
    }

    await expect(resolveLocalConfigFiles(sourceRoot)).resolves.toEqual([
      ".env",
      ".env.local",
      ".env.development.local",
      ".env.production.local",
      ".dev.vars",
      ".envrc",
      ".npmrc",
      "local.settings.json",
      "terraform.tfvars",
      "terraform.tfvars.json",
      "prod.auto.tfvars",
      "extra.auto.tfvars.json",
      "config/master.key",
      "config/credentials/production.key",
      ".streamlit/secrets.toml",
    ]);
  });

  it("does not match conventionally-committed neighbours", async () => {
    for (const name of [
      ".env.example",
      ".env.sample",
      ".env.production",
      ".env.development",
      "vars.tfvars",
      "config/database.yml",
      "package.json",
    ]) {
      await writeSource(name);
    }

    await expect(resolveLocalConfigFiles(sourceRoot)).resolves.toEqual([]);
  });

  it("ignores directories that happen to match a pattern", async () => {
    await mkdir(path.join(sourceRoot, ".env"), { recursive: true });
    await expect(resolveLocalConfigFiles(sourceRoot)).resolves.toEqual([]);
  });

  it("returns an empty list for a source repo with none of them", async () => {
    await expect(resolveLocalConfigFiles(sourceRoot)).resolves.toEqual([]);
  });
});

describe("copyLocalConfigFiles", () => {
  it("copies matches, creating nested destination directories", async () => {
    await writeSource(".env", "FOO=bar\n");
    await writeSource("config/master.key", "abc123\n");

    await expect(
      copyLocalConfigFiles(sourceRoot, worktreePath)
    ).resolves.toEqual([".env", "config/master.key"]);
    await expect(
      readFile(path.join(worktreePath, ".env"), "utf-8")
    ).resolves.toBe("FOO=bar\n");
    await expect(
      readFile(path.join(worktreePath, "config/master.key"), "utf-8")
    ).resolves.toBe("abc123\n");
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

  it("refuses to write through a symlinked destination directory", async () => {
    const outside = path.join(tempRoot, "outside");
    await mkdir(outside, { recursive: true });
    await writeSource(".streamlit/secrets.toml", "secret\n");
    // The worktree tracks `.streamlit` as a symlink escaping the worktree.
    await symlink(outside, path.join(worktreePath, ".streamlit"));

    await expect(
      copyLocalConfigFiles(sourceRoot, worktreePath)
    ).resolves.toEqual([]);
    await expect(
      readFile(path.join(outside, "secrets.toml"))
    ).rejects.toThrow();
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

  it("does not follow a dangling destination symlink out of the worktree", async () => {
    // A dangling link passes an existence check but `copyFile` would follow
    // it, turning every pattern into a write primitive.
    const outside = path.join(tempRoot, "outside");
    await mkdir(outside, { recursive: true });
    await writeSource(".env", "SECRET=1\n");
    await symlink(path.join(outside, "pwned"), path.join(worktreePath, ".env"));

    await expect(
      copyLocalConfigFiles(sourceRoot, worktreePath)
    ).resolves.toEqual([]);
    await expect(readFile(path.join(outside, "pwned"))).rejects.toThrow();
  });

  it("refuses a source that is a symlink out of the repo", async () => {
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

  it("refuses a source whose parent directory escapes the repo", async () => {
    const elsewhere = path.join(tempRoot, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(elsewhere, "master.key"), "PRIVATE KEY\n");
    await symlink(elsewhere, path.join(sourceRoot, "config"));

    await expect(
      copyLocalConfigFiles(sourceRoot, worktreePath)
    ).resolves.toEqual([]);
    await expect(
      readFile(path.join(worktreePath, "config/master.key"))
    ).rejects.toThrow();
  });

  it("still copies a plain nested file when nothing is symlinked", async () => {
    await writeSource("config/master.key", "abc\n");
    await expect(
      copyLocalConfigFiles(sourceRoot, worktreePath)
    ).resolves.toEqual(["config/master.key"]);
  });
});
