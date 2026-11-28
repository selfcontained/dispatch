import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sessionFromWire, type Req } from "@dispatch/runner-protocol/contract";
import { runnerDirectory } from "../src/runners/directory.js";
import { placementForRunner } from "../src/runners/placement.js";
import type { RemoteRunnerService } from "../src/agents/remote/service.js";
import { checkoutWorkload } from "./helpers/checkout-workload.js";
import { ownedCheckoutFixture } from "./helpers/owned-checkout-fixture.js";
let fixture: Awaited<ReturnType<typeof ownedCheckoutFixture>>;
beforeAll(async () => {
  fixture = await ownedCheckoutFixture(checkoutWorkload);
  await writeFile(path.join(fixture.worktree, "owned-only"), "x");
  await writeFile(path.join(fixture.moved, "selected-only"), "x");
});
afterAll(async () => {
  await fixture?.close();
});
async function probe(checkout: "current" | "launch" | "owned", file: string) {
  const row = fixture.rows.find((row) => row.name === "moved-repository")!;
  const placement = placementForRunner("rnr_access");
  const service = {
    call(id: string, op: "checkout.access", input: Req<"checkout.access">) {
      expect(id).toBe("rnr_access");
      return fixture.operation(op, row, input);
    },
  } as unknown as RemoteRunnerService;
  return runnerDirectory({ remote: service }, { ...row, placement })
    .for(placement)
    .call("checkout.access", {
      target: { session: sessionFromWire(row.id), checkout },
      path: file,
    });
}
it.each(["current", "launch", "owned"] as const)(
  "round-trips boolean probes for %s",
  async (selector) => {
    expect(await probe(selector, "owned-only")).toBe(selector !== "current");
    expect(await probe(selector, "selected-only")).toBe(selector === "current");
  }
);
