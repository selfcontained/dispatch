import { spawn } from "node:child_process";
import { runnerGitArgs } from "../src/agents/remote/runner.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  realpath,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  RunnerRepositories,
  prepareScratchSession,
} from "../src/agents/remote/session-storage.js";
import {
  MANAGED_WORKSPACE,
  remotePlacement,
  workspaceLocator,
  type RepositoryCheckout,
} from "../src/agents/remote/protocol.js";

import {
  inferRepositoryUrl,
  parseRepository,
  repositoryUrl,
} from "../src/agents/remote/repository.js";

const execute = promisify(execFile);

async function git(...args: string[]) {
  return (
    await execute("git", args, {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    })
  ).stdout;
}

it("round trips the reserved workspace and recognizes its encoded form", () => {
  const placement = { runner: "test", workspace: MANAGED_WORKSPACE };
  expect(workspaceLocator(placement)).toBe("runner://test/@session");
  expect(remotePlacement("runner://test/@session")).toEqual(placement);
  expect(remotePlacement("runner://test/%40session")).toEqual(placement);
});

it("gives each session private scratch storage and reuses it when restarted", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "dispatch-runner-session-")
  );
  try {
    const uid = process.getuid!();
    const gid = process.getgid!();
    const first = await prepareScratchSession(root, "first", uid, gid);
    const second = await prepareScratchSession(root, "second", uid, gid);
    expect(first).not.toBe(second);
    expect((await stat(first)).mode & 0o777).toBe(0o700);
    await writeFile(path.join(first, "marker"), "session data");
    expect(await prepareScratchSession(root, "first", uid, gid)).toBe(first);
    expect(await readFile(path.join(first, "marker"), "utf8")).toBe(
      "session data"
    );
    await expect(readFile(path.join(second, "marker"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it("sanitizes project origins and rejects unsupported transport or credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dispatch-runner-origin-"));
  try {
    await git("init", root);
    await git(
      "-C",
      root,
      "remote",
      "add",
      "origin",
      "https://user:secret@example.test/fixture.git"
    );
    expect(await inferRepositoryUrl(root)).toBe(
      "https://example.test/fixture.git"
    );
    await git(
      "-C",
      root,
      "config",
      "--add",
      "remote.origin.url",
      "https://example.test/other.git"
    );
    await expect(inferRepositoryUrl(root)).rejects.toThrow(
      "no unambiguous HTTPS"
    );
    expect(repositoryUrl("git@example.test:owner/repo.git", true)).toBe(
      "https://example.test/owner/repo.git"
    );
    for (const value of [
      "/local/repo",
      "file:///tmp/repo",
      "ssh://example.test/repo",
      "ext::some-command",
      "https://user:secret@example.test/repo",
      "https://example.test/repo?token=secret",
    ])
      expect(() => repositoryUrl(value)).toThrow("credential-free HTTPS");
    expect(() =>
      parseRepository({ checkout: { kind: "branch", branch: "--force" } })
    ).toThrow("valid checkout branch");
    expect(() =>
      parseRepository({
        checkout: { kind: "pr", branch: "topic", number: "1" },
      })
    ).toThrow("positive integer");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it("uses isolated worktrees, protects occupied and default branches, and keeps existing branches on removal", async () => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "dispatch-runner-git-"))
  );
  try {
    const origin = path.join(root, "origin");
    await git("init", "-b", "main", origin);
    const commit = async (message: string) => {
      await git(
        "-C",
        origin,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "--allow-empty",
        "-m",
        message
      );
      return (await git("-C", origin, "rev-parse", "HEAD")).trim();
    };
    const initial = await commit("initial");
    await git("-C", origin, "switch", "-c", "topic");
    const topic = await commit("topic");
    await git("-C", origin, "update-ref", "refs/pull/1/head", topic);
    await git("-C", origin, "update-ref", "refs/pull/2/head", initial);
    await git("-C", origin, "switch", "main");
    const url = "https://example.test/fixture.git";
    const cache = path.join(root, "cache");
    const sessions = path.join(root, "sessions");
    const uid = process.getuid!();
    const gid = process.getgid!();
    let failReviewBase = false;
    const repositories = new RunnerRepositories(
      cache,
      uid,
      gid,
      (bin, args) => {
        expect(bin).toBe("git");
        if (
          failReviewBase &&
          args.some((arg) => arg.endsWith(".dispatchReviewBase"))
        ) {
          failReviewBase = false;
          return Promise.reject(new Error("interrupted Git configuration"));
        }
        return git("-c", `url.file://${origin}.insteadOf=${url}`, ...args);
      }
    );
    type Journal = Parameters<RunnerRepositories["prepare"]>[2];
    type Plan = Parameters<Journal["write"]>[0];
    const plans = new Map<string, Plan>();
    const prepare = (
      directory: string,
      repository: Parameters<RunnerRepositories["prepare"]>[1]
    ) =>
      repositories.prepare(directory, repository, {
        read: async () => plans.get(directory) ?? null,
        write: async (plan) => {
          plans.set(directory, plan);
        },
        clear: async () => {
          plans.delete(directory);
        },
      });
    const spec = (checkout: RepositoryCheckout) => ({ url, checkout });
    const session = (key: string) =>
      prepareScratchSession(sessions, key, uid, gid);

    const a = await session("a");
    const b = await session("b");
    const c = await session("c");
    const newBranch = spec({ kind: "new", branch: "work" });
    const existing = spec({ kind: "branch", branch: "topic" });
    const interrupted = await session("interrupted");
    const retry = spec({ kind: "new", branch: "retry", base: "topic" });
    failReviewBase = true;
    await expect(prepare(interrupted, retry)).rejects.toThrow(
      "Could not update"
    );
    const retryPath = path.join(interrupted, "checkout");
    expect(await git("-C", retryPath, "rev-parse", "HEAD")).toBe(topic + "\n");
    await expect(prepare(interrupted, retry)).resolves.toBe(retryPath);
    expect(
      (
        await git("-C", retryPath, "config", "branch.retry.dispatchReviewBase")
      ).trim()
    ).toBe("topic");
    expect(plans.has(interrupted)).toBe(false);

    const [first, second] = await Promise.all([
      prepare(a, newBranch),
      prepare(b, existing),
    ]);
    expect((await git("-C", first, "rev-parse", "HEAD")).trim()).toBe(initial);
    expect((await git("-C", first, "branch", "--show-current")).trim()).toBe(
      "work"
    );
    expect((await git("-C", second, "rev-parse", "HEAD")).trim()).toBe(topic);
    expect((await git("-C", second, "branch", "--show-current")).trim()).toBe(
      "topic"
    );
    expect(await prepare(a, newBranch)).toBe(first);
    await expect(prepare(c, existing)).rejects.toThrow("occupied");
    await expect(
      prepare(c, spec({ kind: "branch", branch: "main" }))
    ).rejects.toThrow("default branch");
    await expect(
      prepare(c, spec({ kind: "new", branch: "topic" }))
    ).rejects.toThrow("already exists");

    await repositories.remove(b, existing);
    await repositories.remove(b, existing);
    expect(
      (await git("-C", first, "rev-parse", "refs/heads/topic")).trim()
    ).toBe(topic);
    const pr = spec({ kind: "pr", branch: "topic", number: 1 });
    expect(
      (await git("-C", await prepare(c, pr), "rev-parse", "HEAD")).trim()
    ).toBe(topic);
    await repositories.remove(c, pr);
    await git("-C", origin, "switch", "topic");
    const updatedTopic = await commit("updated PR head");
    await git("-C", origin, "update-ref", "refs/pull/1/head", updatedTopic);
    await git("-C", origin, "switch", "main");
    const updated = await prepare(c, pr);
    expect((await git("-C", updated, "rev-parse", "HEAD")).trim()).toBe(
      updatedTopic
    );
    expect(
      (
        await git("-C", updated, "rev-parse", "--abbrev-ref", "@{upstream}")
      ).trim()
    ).toBe("origin/topic");
    await git(
      "-C",
      updated,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "local-only work"
    );
    const localHead = (await git("-C", updated, "rev-parse", "HEAD")).trim();
    await repositories.remove(c, pr);
    await git("-C", origin, "switch", "topic");
    const divergent = await commit("different remote work");
    await git("-C", origin, "switch", "main");
    await expect(prepare(c, existing)).rejects.toThrow("has local work");
    expect(
      (await git("-C", first, "rev-parse", "refs/heads/topic")).trim()
    ).toBe(localHead);

    await expect(
      prepare(c, spec({ kind: "pr", branch: "topic", number: 2 }))
    ).rejects.toThrow("does not match");
    const selectedBase = spec({
      kind: "new",
      branch: "from-topic",
      base: "topic",
    });
    expect(
      (
        await git("-C", await prepare(c, selectedBase), "rev-parse", "HEAD")
      ).trim()
    ).toBe(divergent);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it("uses only the runner GitHub helper for a private repository credential request", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "dispatch-runner-credential-")
  );
  try {
    const gh = path.join(root, "gh");
    const calls = path.join(root, "calls");
    const global = path.join(root, "gitconfig");
    await writeFile(
      gh,
      '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$FIXTURE_CALLS"\ncat >> "$FIXTURE_CALLS"\nprintf \'username=fixture\\npassword=synthetic-token\\n\'\n',
      { mode: 0o700 }
    );
    await writeFile(
      global,
      "[credential]\n  helper = !echo unsafe-helper >&2\n"
    );
    const args = runnerGitArgs.map((arg) => arg.replace("/usr/bin/gh", gh));
    const credential = (host: string) =>
      new Promise<{ status: number | null; out: string; err: string }>(
        (resolve, reject) => {
          const child = spawn(
            "git",
            [
              "-C",
              root,
              ...args,
              "-c",
              "credential.useHttpPath=true",
              "credential",
              "fill",
            ],
            {
              env: {
                PATH: process.env.PATH,
                HOME: root,
                GIT_CONFIG_GLOBAL: global,
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_TERMINAL_PROMPT: "0",
                FIXTURE_CALLS: calls,
              },
            }
          );
          let out = "",
            err = "";
          child.stdout.on("data", (chunk) => (out += chunk));
          child.stderr.on("data", (chunk) => (err += chunk));
          child.once("error", reject);
          child.once("close", (status) => resolve({ status, out, err }));
          child.stdin.end(
            `protocol=https\nhost=${host}\npath=fixture/managed-private.git\n\n`
          );
        }
      );
    expect(await credential("github.com")).toMatchObject({
      status: 0,
      out: expect.stringContaining("password=synthetic-token"),
      err: "",
    });
    expect(await readFile(calls, "utf8")).toContain(
      "path=fixture/managed-private.git"
    );
    await rm(calls);
    const rejected = await credential("example.test");
    expect(rejected.status).not.toBe(0);
    expect(rejected.err).not.toContain("unsafe-helper");
    await expect(readFile(calls)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
