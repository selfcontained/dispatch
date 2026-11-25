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
import { pathFromWire } from "@dispatch/runner-protocol/contract";
import { runnerDirectory } from "../src/runners/directory.js";
import { controllerPlacement } from "../src/runners/placement.js";
import { startTestLocalRunner } from "./helpers/local-runner-child.js";

// Capture the instance constructed by runners/local.ts, not another workload.
const fallback = vi.hoisted(() => ({
  workload: undefined as
    | ReturnType<
        (typeof import("../src/agents/checkout-worker.js"))["createCheckoutWorkload"]
      >
    | undefined,
}));
vi.mock("../src/agents/checkout-worker.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/agents/checkout-worker.js")>();
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
});

it.each(["checkout.list", "checkout.read"] as const)(
  "native %s makes one child attempt and recovers through its own port",
  async (op) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "native-child-")));
    const directory = join(root, "files");
    await mkdir(directory);
    await writeFile(join(directory, "a.md"), "content");
    const request =
      op === "checkout.list"
        ? {
            target: { path: pathFromWire(directory) },
            path: "",
            mode: "native" as const,
          }
        : {
            target: { path: pathFromWire(directory) },
            path: "a.md",
            mode: "native" as const,
            encoding: "utf8" as const,
            maxBytes: null,
          };
    const native = vi.spyOn(fallback.workload!, "run");
    await mkdir(join(root, "healthy"));
    const healthy = startTestLocalRunner(join(root, "healthy"));
    let interrupted: ReturnType<typeof startTestLocalRunner> | undefined;
    try {
      await healthy.session.call(
        "runner.describe",
        {},
        { signal: AbortSignal.timeout(5000) }
      );
      const expected = await runnerDirectory({ child: () => healthy.session })
        .for(controllerPlacement)
        .call(op, request as never);
      expect(native).not.toHaveBeenCalled();
      expect(
        await runnerDirectory({})
          .for(controllerPlacement)
          .call(op, request as never)
      ).toEqual(expected);
      expect(native).toHaveBeenCalledTimes(1);
      native.mockClear();
      const marker = join(root, "paused");
      await mkdir(join(root, "interrupted"));
      interrupted = startTestLocalRunner(join(root, "interrupted"), {
        backoffMs: 60000,
        env: { RUNNER_FIXTURE_NATIVE_PAUSE: marker },
      });
      await interrupted.session.call(
        "runner.describe",
        {},
        { signal: AbortSignal.timeout(5000) }
      );
      const child = interrupted;
      const sent = vi.spyOn(child.session, "call");
      const pending = runnerDirectory({ child: () => child.session })
        .for(controllerPlacement)
        .call(op, request as never, { signal: AbortSignal.timeout(5000) });
      await vi.waitFor(
        async () => expect(await readFile(marker, "utf8")).toBe(op + "\n"),
        { timeout: 5000 }
      );
      expect(native).not.toHaveBeenCalled();
      process.kill(child.current()!.pid, "SIGKILL");
      expect(await pending).toEqual(expected);
      expect(native).toHaveBeenCalledTimes(1);
      expect(sent.mock.calls.filter((args) => args[0] === op)).toHaveLength(1);
    } finally {
      await interrupted?.stop();
      await healthy.stop();
      native.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  }
);
