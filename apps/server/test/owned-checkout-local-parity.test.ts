import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  displayPath,
  pathFromWire,
  sessionFromWire,
} from "@dispatch/runner-protocol/contract";
import { BindingStore } from "../../../packages/runner/src/local/bindings.js";
import { bindingFromRow } from "../src/runners/local-bindings.js";
import { runnerDirectory } from "../src/runners/directory.js";
import { controllerPlacement } from "../src/runners/placement.js";
import {
  ownedCheckoutFixture,
  ownerEvidence,
  ownerReply,
} from "./helpers/owned-checkout-fixture.js";
import { startTestLocalRunner } from "./helpers/local-runner-child.js";
const native = vi.hoisted(() => ({
  workload: undefined as
    | ReturnType<
        (typeof import("../../../packages/runner/src/workload/agents/checkout-worker.js"))["createCheckoutWorkload"]
      >
    | undefined,
  factory: undefined as
    | (typeof import("../../../packages/runner/src/workload/agents/checkout-worker.js"))["createCheckoutWorkload"]
    | undefined,
}));
vi.mock(
  "../../../packages/runner/src/workload/agents/checkout-worker.js",
  async (original) => {
    const actual =
      await original<
        typeof import("../../../packages/runner/src/workload/agents/checkout-worker.js")
      >();
    native.factory = actual.createCheckoutWorkload;
    return {
      ...actual,
      createCheckoutWorkload: () => {
        const result = actual.createCheckoutWorkload();
        native.workload = result;
        return result;
      },
    };
  }
);
let fixture: Awaited<ReturnType<typeof ownedCheckoutFixture>>,
  child: ReturnType<typeof startTestLocalRunner>,
  state: string;
beforeAll(async () => {
  // The fixture gets an unwrapped instance; the spy below observes the adapter's.
  fixture = await ownedCheckoutFixture(native.factory!());
  state = path.join(fixture.root, "local");
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
const names = [
  "worktree",
  "no-worktree",
  "moved-repository",
  "moved-subfolder",
  "gone-worktree",
  "non-repository",
] as const;
it.each(
  names.flatMap(
    (name) =>
      [
        [name, "child"],
        [name, "in-process"],
      ] as const
  )
)("pins current/launch behavior before owned (%s, %s)", async (name, mode) => {
  const row = fixture.rows.find((r) => r.name === name)!;
  const agent = { ...row, placement: controllerPlacement, launchCwd: row.cwd };
  const runner = runnerDirectory(
    mode === "child" ? { child: () => child.session } : {},
    agent
  ).for(controllerPlacement);
  const spy = vi.spyOn(native.workload!, "run");
  const read = async (checkout: "current" | "launch") =>
    ownerEvidence(
      await runner
        .call("checkout.read", {
          target: { session: sessionFromWire(row.id), checkout },
          path: ".agents/owners.json",
          encoding: "utf8",
          maxBytes: null,
        })
        .then(ownerReply)
        .catch(() => null)
    );
  try {
    expect(await fixture.main(row)).toEqual(row.expected);
    const current = row.workspacePath ? { "moved-owner": 1 } : row.expected;
    expect(await read("current")).toEqual(current);
    expect(spy).toHaveBeenCalledTimes(mode === "child" ? 0 : 1);
    spy.mockClear();
    expect(await read("launch")).toEqual(
      name === "non-repository" ? { "folder-owner": 1 } : { "main-owner": 1 }
    );
    expect(spy).toHaveBeenCalledTimes(
      mode === "child" && !row.worktreePath ? 0 : 1
    );
  } finally {
    spy.mockRestore();
  }
});
it("keeps imported roots through receiptless resume and child recycle", async () => {
  for (const row of fixture.rows) {
    expect(
      await child.session.call("workspace.resume", {
        session: sessionFromWire(row.id),
      })
    ).toBeNull();
    expect(
      displayPath(
        (
          await child.session.call("workspace.describe", {
            session: sessionFromWire(row.id),
          })
        ).checkoutRoot!
      )
    ).toBe(row.home);
  }
  await child.stop();
  child = startTestLocalRunner(state);
  await child.ready();
  await child.session.call("runner.describe", {});
  for (const row of fixture.rows)
    expect(
      displayPath(
        (
          await child.session.call("workspace.describe", {
            session: sessionFromWire(row.id),
          })
        ).checkoutRoot!
      )
    ).toBe(row.home);
});
it("keeps a prepared worktree's root when its receipt resumes after a workspace move", async () => {
  const session = sessionFromWire("agt_prepared");
  const prepared = await child.session.call("workspace.prepare", {
    session,
    source: { directory: pathFromWire(fixture.repo) },
    worktree: {
      name: "owned-resume",
      branch: "owned-resume",
      base: "main",
      create: true,
    },
    copyIgnored: [],
    installDependencies: false,
  });
  const mainRoot = displayPath(prepared.worktree!.path);
  await child.session.call("workspace.select", {
    session,
    path: pathFromWire(fixture.moved),
  });
  const resumed = await child.session.call("workspace.resume", { session });
  expect(resumed?.worktree?.path).toBe(mainRoot);
  const binding = await new BindingStore(state).get("agt_prepared");
  expect(binding?.checkout.path).toBe(mainRoot);
  expect(binding?.currentPath).toBe(fixture.moved);
});

it.each([true, false])(
  "preserves workspace release across a child recycle (prepared: %s)",
  async (prepared) => {
    const session = sessionFromWire(
      prepared ? "agt_receiptrecycle" : "agt_noreceiptrecycle"
    );
    if (prepared) {
      await child.session.call("workspace.prepare", {
        session,
        source: { directory: pathFromWire(fixture.repo) },
        worktree: {
          name: "receipt-recycle",
          branch: "receipt-recycle",
          base: "main",
          create: true,
        },
        copyIgnored: [],
        installDependencies: false,
      });
    } else {
      await new BindingStore(state).import([
        {
          session,
          path: fixture.repo,
          currentPath: null,
          worktree: null,
        },
      ]);
    }
    await child.stop();
    child = startTestLocalRunner(state);
    await child.ready();
    const resumed = await child.session.call("workspace.resume", { session });
    if (prepared) expect(resumed?.worktree?.branch).toBe("receipt-recycle");
    else expect(resumed).toBeNull();
    expect(
      await child.session.call("workspace.release", {
        session,
        originalBranch: null,
        deleteBranch: false,
      })
    ).toEqual({ removed: prepared });
  }
);

it.each(names)(
  "reads owned through the real child and identical in-process port: %s",
  async (name) => {
    const row = fixture.rows.find((r) => r.name === name)!;
    const spy = vi.spyOn(native.workload!, "run");
    try {
      const reply = await child.session
        .call("checkout.read", {
          target: { session: sessionFromWire(row.id), checkout: "owned" },
          path: ".agents/owners.json",
          encoding: "utf8",
          maxBytes: null,
        })
        .then(ownerReply)
        .catch(() => null);
      expect(ownerEvidence(reply)).toEqual(row.expected);
      expect(spy).not.toHaveBeenCalled();
      expect(
        ownerEvidence(
          await fixture
            .direct(row)
            .then(ownerReply)
            .catch(() => null)
        )
      ).toEqual(row.expected);
    } finally {
      spy.mockRestore();
    }
  }
);

it.each(
  names.flatMap(
    (name) =>
      [
        [name, "child"],
        [name, "no-child"],
      ] as const
  )
)("reads owned through the adapter (%s, %s)", async (name, mode) => {
  const row = fixture.rows.find((r) => r.name === name)!;
  const agent = { ...row, placement: controllerPlacement, launchCwd: row.cwd };
  const runner = runnerDirectory(
    mode === "child" ? { child: () => child.session } : {},
    agent
  ).for(controllerPlacement);
  const port = vi.spyOn(native.workload!, "run");
  const calls = vi.spyOn(child.session, "call");
  try {
    const result = await runner
      .call("checkout.read", {
        target: { session: sessionFromWire(row.id), checkout: "owned" },
        path: ".agents/owners.json",
        encoding: "utf8",
        maxBytes: null,
      })
      .then(ownerReply)
      .catch(() => null);
    expect(ownerEvidence(result)).toEqual(row.expected);
    expect(port).toHaveBeenCalledTimes(mode === "child" ? 0 : 1);
    if (mode === "no-child")
      expect(port.mock.calls[0]?.[1].directory).toBe(row.home);
    else
      expect(
        calls.mock.calls
          .filter(([op]) => op === "checkout.read")
          .map(([, input]) => input)
      ).toEqual([
        {
          target: { session: sessionFromWire(row.id), checkout: "owned" },
          path: ".agents/owners.json",
          encoding: "utf8",
          maxBytes: null,
        },
      ]);
  } finally {
    calls.mockRestore();
    port.mockRestore();
  }
});

it("uses main's path for a legacy mismatched binding without sending the child a wrong read", async () => {
  const home = path.join(fixture.root, "legacy-notes "),
    stale = path.join(fixture.root, "legacy-notes"),
    id = "agt_stale";
  for (const [dir, owner] of [
    [home, "main-owner"],
    [stale, "stale-owner"],
  ]) {
    await mkdir(path.join(dir, ".agents"), { recursive: true });
    await writeFile(
      path.join(dir, ".agents/owners.json"),
      JSON.stringify({
        version: 1,
        rules: [{ paths: ["src/**"], personas: [owner] }],
      })
    );
  }
  // A pre-fix binding is deliberately retained even after a correct row arrives.
  const store = new BindingStore(state);
  await store.import([
    { session: id, path: stale, currentPath: null, worktree: null },
  ]);
  await store.import([
    { session: id, path: home, currentPath: null, worktree: null },
  ]);
  await child.session.call("runner.describe", {});
  const calls = vi.spyOn(child.session, "call"),
    port = vi.spyOn(native.workload!, "run");
  const agent = {
    id,
    cwd: home,
    worktreePath: null,
    workspacePath: null,
    placement: controllerPlacement,
  };
  try {
    const result = await runnerDirectory({ child: () => child.session }, agent)
      .for(controllerPlacement)
      .call("checkout.read", {
        target: { session: sessionFromWire(id), checkout: "owned" },
        path: ".agents/owners.json",
        encoding: "utf8",
        maxBytes: null,
      });
    expect(ownerEvidence(ownerReply(result))).toEqual({ "main-owner": 1 });
    expect(calls.mock.calls.filter(([op]) => op === "checkout.read")).toEqual(
      []
    );
    expect(
      calls.mock.calls.filter(([op]) => op === "workspace.describe")
    ).toHaveLength(1);
    expect(port).toHaveBeenCalledTimes(1);
    expect(port.mock.calls[0]?.[1].directory).toBe(home);
  } finally {
    calls.mockRestore();
    port.mockRestore();
  }
});
