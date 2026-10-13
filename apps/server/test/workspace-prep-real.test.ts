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
import type { FastifyBaseLogger } from "fastify";
import { expect, it, vi } from "vitest";
import { setupAgentWorkspace } from "../src/agents/workspace-prep.js";
import { runCommand } from "../src/shared/lib/run-command.js";
import { withToolSearchPath } from "../src/shared/lib/tool-environment.js";

it("installs real pnpm dependencies with service PATH, no CI, and ignored stdin", async () => {
  const pnpmPath = (await runCommand("which", ["pnpm"])).stdout;
  const root = await mkdtemp(path.join(os.tmpdir(), "dispatch-pnpm-service-"));
  const home = path.join(root, "home");
  const workspace = path.join(root, "worktree");
  const bin = path.join(home, ".local/bin");
  const serviceBin = path.join(root, "service-bin");
  await mkdir(bin, { recursive: true });
  await mkdir(serviceBin);
  await symlink("/bin/sh", path.join(serviceBin, "sh"));
  await mkdir(path.join(workspace, "dependency"), { recursive: true });
  // Model a user-installed manager outside the service's PATH. Both links
  // point to actual executables; no command runner or package manager is mocked.
  await symlink(pnpmPath, path.join(bin, "pnpm"));
  await symlink(process.execPath, path.join(bin, "node"));
  await writeFile(
    path.join(workspace, "dependency/package.json"),
    JSON.stringify({
      name: "local-launch-dependency",
      version: "1.0.0",
      main: "index.js",
    })
  );
  await writeFile(
    path.join(workspace, "dependency/index.js"),
    "module.exports = 'installed';\n"
  );
  await writeFile(
    path.join(workspace, "package.json"),
    JSON.stringify({
      name: "launch-pnpm-fixture",
      private: true,
      dependencies: { "local-launch-dependency": "file:dependency" },
      scripts: {
        postinstall:
          "node -e \"require('fs').writeFileSync('install-complete.txt', require('local-launch-dependency'))\"",
      },
    })
  );
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as FastifyBaseLogger;
  const progress = vi.fn().mockResolvedValue(undefined);
  try {
    vi.stubEnv("HOME", home);
    // Control the baseline so a system-installed pnpm cannot mask a missing
    // fallback environment. Only the lifecycle shell is initially discoverable.
    vi.stubEnv("PATH", serviceBin);
    vi.stubEnv("CI", undefined);
    await expect(runCommand("pnpm", ["--version"])).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (
        await runCommand("/bin/sh", ["-c", "command -v pnpm"], {
          env: withToolSearchPath(),
        })
      ).stdout
    ).toBe(path.join(bin, "pnpm"));
    await runCommand(
      "pnpm",
      ["install", "--lockfile-only", "--ignore-scripts"],
      { cwd: workspace, env: withToolSearchPath(), timeoutMs: 120_000 }
    );
    await setupAgentWorkspace(root, workspace, logger, progress);
    expect(
      await readFile(path.join(workspace, "install-complete.txt"), "utf8")
    ).toBe("installed");
    expect(progress.mock.calls.at(-1)?.[0]).toEqual({
      phase: "deps",
      status: "done",
      detail: "pnpm install completed",
    });
    expect(logger.warn).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
