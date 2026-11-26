import { afterAll, beforeAll, expect, it } from "vitest";
import { checkoutWorkload } from "./helpers/checkout-workload.js";
import {
  ownedCheckoutFixture,
  ownerEvidence,
  ownerReply,
} from "./helpers/owned-checkout-fixture.js";
let fixture: Awaited<ReturnType<typeof ownedCheckoutFixture>>;
beforeAll(async () => {
  fixture = await ownedCheckoutFixture(checkoutWorkload);
  await fixture.finalizeGone();
});
afterAll(async () => {
  await fixture?.close();
});
const cases = [
  ["worktree", { "worktree-owner": 1 }],
  ["no-worktree", { "main-owner": 1 }],
  ["moved-repository", { "moved-owner": 1 }],
  ["moved-subfolder", { "moved-owner": 1 }],
  ["gone-worktree", {}],
  ["non-repository", { "folder-owner": 1 }],
] as const;
it.each(cases)(
  "pins old enrolled assessment and main's desired owned output: %s",
  async (name, old) => {
    const row = fixture.rows.find((r) => r.name === name)!;
    expect(await fixture.main(row)).toEqual(row.expected);
    const read = async (selector: "current" | "launch") =>
      ownerEvidence(
        await fixture
          .read(row, selector)
          .then(ownerReply)
          .catch(() => null)
      );
    expect(await read("current")).toEqual(old);
    // Existing enrolled launch is the immutable checkout that owned will name.
    expect(await read("launch")).toEqual(row.expected);
    expect(await fixture.stored(row)).toBe(row.home);
  }
);
it("keeps owned/current roots after supervisor resume from persisted bindings", async () => {
  await fixture.restart();
  for (const [name, old] of cases) {
    const row = fixture.rows.find((r) => r.name === name)!;
    expect(
      ownerEvidence(
        await fixture
          .read(row, "current")
          .then(ownerReply)
          .catch(() => null)
      )
    ).toEqual(old);
    expect(
      ownerEvidence(
        await fixture
          .read(row, "launch")
          .then(ownerReply)
          .catch(() => null)
      )
    ).toEqual(row.expected);
  }
});
