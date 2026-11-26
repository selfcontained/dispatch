import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { sessionFromWire } from "@dispatch/runner-protocol/contract";
import { BindingStore } from "../../../packages/runner/src/local/bindings.js";
import { bindingFromRow } from "../src/runners/local-bindings.js";
import { localCheckoutWorkload } from "../src/runners/local.js";
import { runnerDirectory } from "../src/runners/directory.js";
import { controllerPlacement } from "../src/runners/placement.js";
import { checkoutWorkload } from "./helpers/checkout-workload.js";
import { ownedCheckoutFixture } from "./helpers/owned-checkout-fixture.js";
import { startTestLocalRunner } from "./helpers/local-runner-child.js";
let fixture: Awaited<ReturnType<typeof ownedCheckoutFixture>>;
let child: ReturnType<typeof startTestLocalRunner>;
let state: string;
beforeAll(async () => {
  fixture = await ownedCheckoutFixture(checkoutWorkload);
  state = path.join(fixture.root, "local-access");
  const store = new BindingStore(state);
  for (const row of fixture.rows) {
    await store.import([bindingFromRow({ ...row, workspacePath: null })]);
    if (row.workspacePath) await store.select(row.id, row.workspacePath);
  }
  await fixture.finalizeGone();
  child = startTestLocalRunner(state);
  await child.ready();
  await child.session.call("runner.describe", {});
});
afterAll(async () => {
  await child?.stop();
  await fixture?.close();
});
const cases = [
  "worktree",
  "no-worktree",
  "moved-repository",
  "moved-subfolder",
  "gone-worktree",
  "non-repository",
] as const;
it.each(
  cases.flatMap(
    (name) =>
      [
        [name, "child"],
        [name, "no-child"],
      ] as const
  )
)("matches main's owned F_OK root (%s, %s)", async (name, mode) => {
  const row = fixture.rows.find((row) => row.name === name)!;
  const file = ".agents/owners.json";
  const expected = await access(path.join(row.home, file))
    .then(() => true)
    .catch((error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
  const port = vi.spyOn(localCheckoutWorkload, "run");
  const calls = vi.spyOn(child.session, "call");
  try {
    const result = await runnerDirectory(
      mode === "child" ? { child: () => child.session } : {},
      { ...row, launchCwd: row.cwd, placement: controllerPlacement }
    )
      .for(controllerPlacement)
      .call("checkout.access", {
        target: { session: sessionFromWire(row.id), checkout: "owned" },
        path: file,
      });
    expect(result).toBe(expected);
    expect(port).toHaveBeenCalledTimes(mode === "child" ? 0 : 1);
    if (mode === "child")
      expect(
        calls.mock.calls
          .filter(([op]) => op === "checkout.access")
          .map(([, input]) => input)
      ).toEqual([
        {
          target: { session: sessionFromWire(row.id), checkout: "owned" },
          path: file,
        },
      ]);
    else
      expect(port.mock.calls[0]?.[1]).toEqual({
        directory: row.home,
        request: { path: file },
      });
  } finally {
    calls.mockRestore();
    port.mockRestore();
  }
});
it.each(["child", "no-child"] as const)(
  "preserves native F_OK error details through %s",
  async (mode) => {
    const row = fixture.rows[0]!,
      file = ".agents/owners.json/child";
    const expected = await access(path.join(row.home, file))
      .then(() => null)
      .catch((error) => error as NodeJS.ErrnoException);
    const port = vi.spyOn(localCheckoutWorkload, "run");
    try {
      await expect(
        runnerDirectory(
          mode === "child" ? { child: () => child.session } : {},
          { ...row, placement: controllerPlacement }
        )
          .for(controllerPlacement)
          .call("checkout.access", {
            target: { session: sessionFromWire(row.id), checkout: "owned" },
            path: file,
          })
      ).rejects.toMatchObject({
        code: "failed",
        message: expected!.message,
        details: {
          code: expected!.code,
          path: expected!.path,
          syscall: expected!.syscall,
        },
      });
      expect(port).toHaveBeenCalledTimes(mode === "child" ? 0 : 1);
    } finally {
      port.mockRestore();
    }
  }
);
it("compares a retained stale binding before probing the desired exact path", async () => {
  const id = "access_stale",
    home = path.join(fixture.root, "probe-notes "),
    stale = path.join(fixture.root, "probe-notes");
  await mkdir(home);
  await mkdir(stale);
  await writeFile(path.join(home, "file"), "present");
  const store = new BindingStore(state);
  await store.import([
    { session: id, path: stale, currentPath: null, worktree: null },
  ]);
  await store.import([
    { session: id, path: home, currentPath: null, worktree: null },
  ]);
  const port = vi.spyOn(localCheckoutWorkload, "run"),
    calls = vi.spyOn(child.session, "call");
  try {
    expect(
      await runnerDirectory(
        { child: () => child.session },
        {
          id,
          cwd: home,
          worktreePath: null,
          workspacePath: null,
          placement: controllerPlacement,
        }
      )
        .for(controllerPlacement)
        .call("checkout.access", {
          target: { session: sessionFromWire(id), checkout: "owned" },
          path: "file",
        })
    ).toBe(true);
    expect(calls.mock.calls.filter(([op]) => op === "checkout.access")).toEqual(
      []
    );
    expect(port).toHaveBeenCalledTimes(1);
    expect(port.mock.calls[0]?.[1]).toEqual({
      directory: home,
      request: { path: "file" },
    });
  } finally {
    calls.mockRestore();
    port.mockRestore();
  }
});
it("falls back once after a real child loses an accepted access call", async () => {
  const row = fixture.rows[0]!,
    root = path.join(fixture.root, "lost-access"),
    marker = path.join(fixture.root, "access-accepted");
  await new BindingStore(root).import([
    bindingFromRow({ ...row, workspacePath: null }),
  ]);
  const lost = startTestLocalRunner(root, {
    backoffMs: 60000,
    env: { RUNNER_FIXTURE_NATIVE_PAUSE: marker },
  });
  const port = vi.spyOn(localCheckoutWorkload, "run"),
    calls = vi.spyOn(lost.session, "call");
  try {
    await lost.session.call("runner.describe", {});
    const pending = runnerDirectory(
      { child: () => lost.session },
      { ...row, placement: controllerPlacement }
    )
      .for(controllerPlacement)
      .call(
        "checkout.access",
        {
          target: { session: sessionFromWire(row.id), checkout: "owned" },
          path: ".agents/owners.json",
        },
        { signal: AbortSignal.timeout(5000) }
      );
    await vi.waitFor(
      async () =>
        expect(await readFile(marker, "utf8")).toBe("checkout.access\n"),
      { timeout: 5000 }
    );
    expect(port).not.toHaveBeenCalled();
    process.kill(lost.current()!.pid, "SIGKILL");
    expect(await pending).toBe(true);
    expect(
      calls.mock.calls.filter(([op]) => op === "checkout.access")
    ).toHaveLength(1);
    expect(port).toHaveBeenCalledTimes(1);
    expect(port.mock.calls[0]?.[1]).toEqual({
      directory: row.home,
      request: { path: ".agents/owners.json" },
    });
  } finally {
    calls.mockRestore();
    port.mockRestore();
    await lost.stop();
  }
});
