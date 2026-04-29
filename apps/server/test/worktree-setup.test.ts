import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(),
}));

const { setupWorktree } = await import("../src/shared/git/worktree.js");
const { runCommand } = await import("../src/shared/lib/run-command.js");

const noopLogger = (() => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: "silent",
    child: () => logger,
  };
  return logger as unknown as import("fastify").FastifyBaseLogger;
})();

let tempRoot: string;
let originalCwd: string;
let worktreePath: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "worktree-setup-test-"));
  originalCwd = path.join(tempRoot, "src-repo");
  worktreePath = path.join(tempRoot, "wt");
  await mkdir(originalCwd, { recursive: true });
  await mkdir(worktreePath, { recursive: true });
  vi.mocked(runCommand).mockReset();
  // Default: any package-manager invocation succeeds with empty output.
  vi.mocked(runCommand).mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("setupWorktree — .env copy", () => {
  it("copies .env from the source repo into the worktree when present", async () => {
    await writeFile(path.join(originalCwd, ".env"), "FOO=bar\nBAZ=qux\n");
    await setupWorktree(originalCwd, worktreePath, noopLogger);

    const copied = await readFile(path.join(worktreePath, ".env"), "utf-8");
    expect(copied).toBe("FOO=bar\nBAZ=qux\n");
  });

  it("does not error when the source .env is missing (best-effort)", async () => {
    await expect(
      setupWorktree(originalCwd, worktreePath, noopLogger)
    ).resolves.toBeUndefined();
    // Confirm no .env was created in the worktree.
    await expect(readFile(path.join(worktreePath, ".env"))).rejects.toThrow();
  });
});

describe("setupWorktree — auto deps install", () => {
  it("runs pnpm install when pnpm-lock.yaml is present", async () => {
    await writeFile(
      path.join(worktreePath, "pnpm-lock.yaml"),
      "lockfileVersion: 6\n"
    );
    await setupWorktree(originalCwd, worktreePath, noopLogger);

    const installCall = vi
      .mocked(runCommand)
      .mock.calls.find(([cmd]) => cmd === "pnpm");
    expect(installCall).toBeDefined();
    expect(installCall?.[1]).toEqual(["install"]);
    expect(installCall?.[2]?.cwd).toBe(worktreePath);
  });

  it("falls through the priority order — pnpm > yarn > npm > bun", async () => {
    // Both pnpm and yarn lockfiles present; pnpm wins.
    await writeFile(path.join(worktreePath, "pnpm-lock.yaml"), "");
    await writeFile(path.join(worktreePath, "yarn.lock"), "");
    await setupWorktree(originalCwd, worktreePath, noopLogger);

    const calls = vi.mocked(runCommand).mock.calls.map(([cmd]) => cmd);
    expect(calls).toContain("pnpm");
    expect(calls).not.toContain("yarn");
  });

  it("runs npm install when only package-lock.json is present", async () => {
    await writeFile(path.join(worktreePath, "package-lock.json"), "{}");
    await setupWorktree(originalCwd, worktreePath, noopLogger);

    const installCall = vi
      .mocked(runCommand)
      .mock.calls.find(([cmd]) => cmd === "npm");
    expect(installCall).toBeDefined();
    expect(installCall?.[1]).toEqual(["install"]);
  });

  it("runs bun install when only bun.lockb is present", async () => {
    await writeFile(path.join(worktreePath, "bun.lockb"), "");
    await setupWorktree(originalCwd, worktreePath, noopLogger);

    const installCall = vi
      .mocked(runCommand)
      .mock.calls.find(([cmd]) => cmd === "bun");
    expect(installCall).toBeDefined();
  });

  it("invokes no install command when no lockfile is present", async () => {
    await setupWorktree(originalCwd, worktreePath, noopLogger);

    const calls = vi.mocked(runCommand).mock.calls;
    expect(calls).toEqual([]);
  });

  it("survives a failing install (logs warn, does not propagate)", async () => {
    const warnSpy = vi.fn();
    const logger = {
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      silent: vi.fn(),
      level: "silent",
      child: () => logger,
    } as unknown as import("fastify").FastifyBaseLogger;

    await writeFile(path.join(worktreePath, "pnpm-lock.yaml"), "");
    vi.mocked(runCommand).mockRejectedValue(new Error("install crashed"));

    await expect(
      setupWorktree(originalCwd, worktreePath, logger)
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[1]).toBe("Dependency install failed.");
  });
});
