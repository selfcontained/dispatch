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
      ".claude/settings.local.json",
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
      ".claude/settings.local.json",
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
});
