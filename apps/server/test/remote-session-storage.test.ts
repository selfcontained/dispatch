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
    const repositories = new RunnerRepositories(
      cache,
      uid,
      gid,
      (bin, args) => {
        expect(bin).toBe("git");
        return git("-c", `url.file://${origin}.insteadOf=${url}`, ...args);
      }
    );
    const spec = (checkout: RepositoryCheckout) => ({ url, checkout });
    const session = (key: string) =>
      prepareScratchSession(sessions, key, uid, gid);

    const a = await session("a");
    const b = await session("b");
    const c = await session("c");
    const newBranch = spec({ kind: "new", branch: "work" });
    const existing = spec({ kind: "branch", branch: "topic" });
    const [first, second] = await Promise.all([
      repositories.prepare(a, newBranch),
      repositories.prepare(b, existing),
    ]);
    expect((await git("-C", first, "rev-parse", "HEAD")).trim()).toBe(initial);
    expect((await git("-C", first, "branch", "--show-current")).trim()).toBe(
      "work"
    );
    expect((await git("-C", second, "rev-parse", "HEAD")).trim()).toBe(topic);
    expect((await git("-C", second, "branch", "--show-current")).trim()).toBe(
      "topic"
    );
    expect(await repositories.prepare(a, newBranch)).toBe(first);
    await expect(repositories.prepare(c, existing)).rejects.toThrow("occupied");
    await expect(
      repositories.prepare(c, spec({ kind: "branch", branch: "main" }))
    ).rejects.toThrow("default branch");
    await expect(
      repositories.prepare(c, spec({ kind: "new", branch: "topic" }))
    ).rejects.toThrow("already exists");

    await repositories.remove(b, existing);
    await repositories.remove(b, existing);
    expect(
      (await git("-C", first, "rev-parse", "refs/heads/topic")).trim()
    ).toBe(topic);
    const pr = spec({ kind: "pr", branch: "topic", number: 1 });
    expect(
      (
        await git("-C", await repositories.prepare(c, pr), "rev-parse", "HEAD")
      ).trim()
    ).toBe(topic);
    await repositories.remove(c, pr);
    await expect(
      repositories.prepare(c, spec({ kind: "pr", branch: "topic", number: 2 }))
    ).rejects.toThrow("does not match");
    const selectedBase = spec({
      kind: "new",
      branch: "from-topic",
      base: "topic",
    });
    expect(
      (
        await git(
          "-C",
          await repositories.prepare(c, selectedBase),
          "rev-parse",
          "HEAD"
        )
      ).trim()
    ).toBe(topic);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
