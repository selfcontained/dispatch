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
import { toPersonaDefinition } from "../src/personas/loader.js";
import {
  ownedCheckoutFixture,
  ownerEvidence,
  ownerReply,
} from "./helpers/owned-checkout-fixture.js";
import { startTestLocalRunner } from "./helpers/local-runner-child.js";
const native = vi.hoisted(() => ({
  workload: undefined as
    | ReturnType<
        (typeof import("../src/agents/checkout-worker.js"))["createCheckoutWorkload"]
      >
    | undefined,
  factory: undefined as
    | (typeof import("../src/agents/checkout-worker.js"))["createCheckoutWorkload"]
    | undefined,
}));
vi.mock("../src/agents/checkout-worker.js", async (original) => {
  const actual =
    await original<typeof import("../src/agents/checkout-worker.js")>();
  native.factory = actual.createCheckoutWorkload;
  return {
    ...actual,
    createCheckoutWorkload: (
      inputs: Parameters<typeof actual.createCheckoutWorkload>[0]
    ) => {
      const result = actual.createCheckoutWorkload(inputs);
      native.workload = result;
      return result;
    },
  };
});
let fixture: Awaited<ReturnType<typeof ownedCheckoutFixture>>,
  child: ReturnType<typeof startTestLocalRunner>,
  state: string;
beforeAll(async () => {
  // The fixture gets an unwrapped instance; the spy below observes the adapter's.
  fixture = await ownedCheckoutFixture(
    native.factory!({ parseDefinition: toPersonaDefinition })
  );
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
