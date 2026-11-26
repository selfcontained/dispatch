import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  open,
  realpath,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPersonas } from "../src/personas/loader.js";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { pathFromWire } from "@dispatch/runner-protocol/contract";
import { localReadDeadline } from "../src/runners/local.js";
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

it("restores controller-relative error spelling when the child has a different cwd", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-relative-child-"))
  );
  await mkdir(join(root, ".agents/personas"), { recursive: true });
  await symlink("missing", join(root, ".agents/personas/a.md"));
  await mkdir(join(root, "state"));
  await mkdir(join(root, "elsewhere"));
  const child = startTestLocalRunner(join(root, "state"), {
    env: { RUNNER_FIXTURE_CWD: join(root, "elsewhere") },
  });
  const native = vi.spyOn(fallback.workload!, "run");
  try {
    await child.session.call(
      "runner.describe",
      {},
      { signal: AbortSignal.timeout(5000) }
    );
    const relative = path.relative(process.cwd(), root);
    const warnings: string[] = [];
    expect(
      await loadPersonas(relative, warnings, { child: () => child.session })
    ).toEqual([]);
    expect(warnings).toEqual([
      `Could not load persona .agents/personas/a.md: ENOENT: no such file or directory, open '${path.join(relative, ".agents/personas/a.md")}'`,
    ]);
    expect(native).not.toHaveBeenCalled();
  } finally {
    await child.stop();
    native.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["checkout.list", "checkout.read"] as const)(
  "native %s adapter deadline falls back once and preserves main's eventual result",
  async (op) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "native-deadline-"))
    );
    await mkdir(join(root, "state"));
    const file = join(root, "a.md");
    if (op === "checkout.read") execFileSync("mkfifo", [file]);
    else await writeFile(file, "content");
    const marker = join(root, "paused");
    const child = startTestLocalRunner(join(root, "state"), {
      env: { RUNNER_FIXTURE_NATIVE_PAUSE: marker },
    });
    const native = vi.spyOn(fallback.workload!, "run");
    let deadline: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await child.session.call(
        "runner.describe",
        {},
        { signal: AbortSignal.timeout(5000) }
      );
      deadline = vi.spyOn(localReadDeadline, "ms").mockReturnValue(500);
      const sent = vi.spyOn(child.session, "call");
      const request =
        op === "checkout.list"
          ? {
              target: { path: pathFromWire(root) },
              path: "",
              mode: "native" as const,
            }
          : {
              target: { path: pathFromWire(root) },
              path: "a.md",
              mode: "native" as const,
              encoding: "utf8" as const,
              maxBytes: null,
            };
      let settled = false;
      const pending = runnerDirectory({ child: () => child.session })
        .for(controllerPlacement)
        .call(op, request as never)
        .finally(() => {
          settled = true;
        });
      await vi.waitFor(
        async () => expect(await readFile(marker, "utf8")).toBe(op + "\n"),
        { timeout: 5000 }
      );
      await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(1), {
        timeout: 5000,
      });
      if (op === "checkout.read") {
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(settled).toBe(false);
        await writeFile(file, "content");
        expect(await pending).toMatchObject({ data: "content" });
      } else
        expect(await pending).toEqual({
          entries: [],
          names: await readdir(root),
          truncated: false,
        });
      expect(native).toHaveBeenCalledTimes(1);
      expect(sent.mock.calls.filter((args) => args[0] === op)).toHaveLength(1);
      expect(sent.mock.calls.find((args) => args[0] === op)![2]).toMatchObject({
        wait: false,
        timeoutMs: null,
      });
    } finally {
      deadline?.mockRestore();
      await child.stop();
      native.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  }
);

it.each(["checkout.list", "checkout.read"] as const)(
  "native %s caller cancellation does not become a fallback",
  async (op) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "native-cancel-"))
    );
    await mkdir(join(root, "state"));
    await writeFile(join(root, "a.md"), "content");
    const marker = join(root, "paused");
    const child = startTestLocalRunner(join(root, "state"), {
      env: { RUNNER_FIXTURE_NATIVE_PAUSE: marker },
    });
    const native = vi.spyOn(fallback.workload!, "run");
    try {
      await child.session.call(
        "runner.describe",
        {},
        { signal: AbortSignal.timeout(5000) }
      );
      const controller = new AbortController();
      const request =
        op === "checkout.list"
          ? {
              target: { path: pathFromWire(root) },
              path: "",
              mode: "native" as const,
            }
          : {
              target: { path: pathFromWire(root) },
              path: "a.md",
              mode: "native" as const,
              encoding: "utf8" as const,
              maxBytes: null,
            };
      const pending = runnerDirectory({ child: () => child.session })
        .for(controllerPlacement)
        .call(op, request as never, { signal: controller.signal });
      const rejected = expect(pending).rejects.toMatchObject({
        code: "cancelled",
      });
      await vi.waitFor(
        async () => expect(await readFile(marker, "utf8")).toBe(op + "\n"),
        { timeout: 5000 }
      );
      controller.abort();
      await rejected;
      expect(native).not.toHaveBeenCalled();
    } finally {
      await child.stop();
      native.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  }
);

// Open difference: local read deadline starts a second reader while the child is
// still reading a consuming entry. Must close before the seal; adapter owner
// switches this to a normal pass when responsive children keep their original read.
it.fails(
  "preserves a FIFO's bytes when the responsive child passes the read deadline",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "native-fifo-inflight-"))
    );
    await mkdir(join(root, "state"));
    const file = join(root, "a.md");
    execFileSync("mkfifo", [file]);
    const child = startTestLocalRunner(join(root, "state"));
    const native = vi.spyOn(fallback.workload!, "run");
    let deadline: ReturnType<typeof vi.spyOn> | undefined;
    let writer: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await child.session.call(
        "runner.describe",
        {},
        { signal: AbortSignal.timeout(5000) }
      );
      deadline = vi.spyOn(localReadDeadline, "ms").mockReturnValue(500);
      const pending = runnerDirectory({ child: () => child.session })
        .for(controllerPlacement)
        .call("checkout.read", {
          target: { path: pathFromWire(root) },
          path: "a.md",
          mode: "native",
          encoding: "utf8",
          maxBytes: null,
        });
      writer = await open(file, "w");
      const prefix = "p".repeat(256 * 1024);
      const suffix = "s".repeat(256 * 1024);
      await writer.writeFile(prefix);
      // The reader is alive and responsive while awaiting more FIFO input.
      await child.session.call(
        "runner.describe",
        {},
        { signal: AbortSignal.timeout(1000) }
      );
      await new Promise((resolve) => setTimeout(resolve, 750));
      await writer.writeFile(suffix);
      await writer.close();
      writer = undefined;
      const reply = await pending;
      expect(reply?.data.length).toBe(prefix.length + suffix.length);
      expect(reply?.data).toBe(prefix + suffix);
      expect(native).not.toHaveBeenCalled();
    } finally {
      await writer?.close();
      deadline?.mockRestore();
      await child.stop();
      native.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  }
);
