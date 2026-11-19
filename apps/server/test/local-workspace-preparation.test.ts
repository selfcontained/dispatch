import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { expect, it, vi } from "vitest";
import { createLocalRunner } from "../src/agents/local-runner.js";
import { runCommand } from "../src/shared/lib/run-command.js";

const logger = { info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger;

it("prepares native folders, direct checkouts and independent worktrees", async () => {
  const root = await mkdtemp(
    path.join(await realpath(os.tmpdir()), "runner-workspace-")
  );
  const checkout = path.join(root, "repository");
  const folder = path.join(root, "folder");
  const hosts = path.join(root, "hosts");
  const runner = createLocalRunner(hosts, logger);
  const git = async (cwd: string, ...args: string[]) =>
    (await runCommand("git", ["-C", cwd, ...args])).stdout;
  const progress = vi.fn().mockResolvedValue(undefined);
  try {
    await mkdir(folder);
    await mkdir(checkout);
    await git(checkout, "init", "-b", "main");
    await writeFile(path.join(checkout, ".gitignore"), ".env\n");
    await git(checkout, "add", ".gitignore");
    const commit = (message: string) =>
      git(
        checkout,
        "-c",
        "user.name=Runner",
        "-c",
        "user.email=runner@example.test",
        "commit",
        "--allow-empty",
        "-m",
        message
      );
    await commit("main");
    await git(checkout, "switch", "-c", "develop");
    await commit("develop");
    const base = await git(checkout, "rev-parse", "HEAD");
    await git(checkout, "switch", "main");
    await writeFile(path.join(checkout, ".env"), "LOCAL_CONFIG=fixture\n");

    const native = await runner.resolveLaunchDirectory(checkout);
    expect(
      await runner.prepareWorkspace(
        "folder",
        await runner.resolveLaunchDirectory(folder),
        null,
        progress
      )
    ).toMatchObject({
      effectiveCwd: folder,
      git: { status: "ok", value: null },
    });
    expect(
      await runner.prepareWorkspace("direct", native, null, progress)
    ).toMatchObject({
      effectiveCwd: checkout,
      worktreePath: null,
      git: { value: { branch: "main", repoRoot: checkout } },
    });
    await expect(
      runner.prepareWorkspace(
        "busy",
        native,
        {
          name: "Busy",
          branch: "main",
          createNewBranch: false,
        },
        progress
      )
    ).rejects.toMatchObject({ statusCode: 409 });

    const request = {
      name: "Work",
      branch: "session/work",
      baseBranch: "develop",
      createNewBranch: true,
    };
    await expect(
      runner.prepareWorkspace("work", native, request, async (step) => {
        if (step.phase === "deps") throw new Error("interrupted preparation");
      })
    ).rejects.toThrow("interrupted preparation");
    const restartedRunner = createLocalRunner(hosts, logger);
    const resumed = await restartedRunner.resumeWorkspace("work", progress);
    expect(resumed).toMatchObject({
      baseBranch: "develop",
      worktreeBranch: "session/work",
    });
    const worktree = resumed!.effectiveCwd;
    expect(await git(worktree, "rev-parse", "HEAD")).toBe(base);
    expect(await readFile(path.join(worktree, ".env"), "utf8")).toBe(
      "LOCAL_CONFIG=fixture\n"
    );
    await expect(
      restartedRunner.prepareWorkspace("other", native, request, progress)
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await git(worktree, "branch", "--show-current")).toBe(
      "session/work"
    );
    expect(
      (await git(checkout, "worktree", "list", "--porcelain")).match(
        /^worktree /gm
      )
    ).toHaveLength(2);
    // The failed request can retry once its branch is available again.
    await git(checkout, "switch", "develop");
    const available = await restartedRunner.resumeWorkspace("busy", progress);
    expect(available).toMatchObject({
      baseBranch: "main",
      worktreeBranch: "main",
    });
    expect(await git(checkout, "branch", "--show-current")).toBe("develop");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
