import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runnerDirectory } from "../src/runners/directory.js";
import { controllerPlacement } from "../src/runners/placement.js";
import { startTestLocalRunner } from "./helpers/local-runner-child.js";

// Capture the instance constructed by runners/local.ts, not another workload.
const fallback = vi.hoisted(() => ({
  workload: undefined as
    | ReturnType<
        (typeof import("../../../packages/runner/src/workload/agents/checkout-worker.js"))["createCheckoutWorkload"]
      >
    | undefined,
}));
vi.mock(
  "../../../packages/runner/src/workload/agents/checkout-worker.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../packages/runner/src/workload/agents/checkout-worker.js")
      >();
    return {
      ...actual,
      createCheckoutWorkload: (
        inputs: Parameters<typeof actual.createCheckoutWorkload>[0]
      ) => {
        const workload = actual.createCheckoutWorkload(inputs);
        fallback.workload = workload;
        return workload;
      },
    };
  }
);

it("git.origin reads identically when a real child dies during its Git command", async () => {
  const op = "git.origin" as const;
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "git-read-recovery-"))
  );
  const repo = join(root, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "--quiet", repo]);
  execFileSync("git", [
    "-C",
    repo,
    "config",
    "remote.origin.url",
    "https://example.com/repo.git",
  ]);
  const request = { path: repo };
  const native = vi.spyOn(fallback.workload!, "run");
  await mkdir(join(root, "healthy"));
  const healthy = startTestLocalRunner(join(root, "healthy"));
  let interrupted: ReturnType<typeof startTestLocalRunner> | undefined;
  const marker = join(root, "git-pid");
  const kill = (pid: number) => {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  try {
    await vi.waitFor(() => expect(healthy.current()).not.toBeNull(), {
      timeout: 5_000,
    });
    await healthy.session.call(
      "runner.describe",
      {},
      { signal: AbortSignal.timeout(5_000) }
    );
    const expected = await runnerDirectory({ child: () => healthy.session })
      .for(controllerPlacement)
      .call(op, request);
    expect(native).not.toHaveBeenCalled();
    const bin = join(root, "bin");
    await mkdir(bin);
    // Only this test child's Git command blocks. The in-process fallback keeps
    // the test process's original PATH and executes the real Git command.
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\nprintf '%s' "$$" > ${JSON.stringify(marker)}\nexec /bin/sleep 60\n`,
      { mode: 0o700 }
    );
    await mkdir(join(root, "interrupted"));
    interrupted = startTestLocalRunner(join(root, "interrupted"), {
      backoffMs: 60_000,
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    await vi.waitFor(() => expect(interrupted!.current()).not.toBeNull(), {
      timeout: 5_000,
    });
    await interrupted.session.call(
      "runner.describe",
      {},
      { signal: AbortSignal.timeout(5_000) }
    );
    const childPid = interrupted.current()!.pid;
    const child = interrupted;
    const pending = runnerDirectory({ child: () => child.session })
      .for(controllerPlacement)
      .call(op, request, { signal: AbortSignal.timeout(5_000) });
    await vi.waitFor(
      async () => expect(await readFile(marker, "utf8")).toMatch(/^\d+$/),
      { timeout: 5_000 }
    );
    kill(childPid);
    expect(await pending).toEqual(expected);
    expect(native).toHaveBeenCalledTimes(1);
    expect(native.mock.calls[0][0]).toBe(op);
  } finally {
    const gitPid = Number(await readFile(marker, "utf8").catch(() => ""));
    if (gitPid > 0) kill(gitPid);
    await interrupted?.stop();
    await healthy.stop();
    native.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
