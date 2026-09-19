import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { isTrimmedLaunchGuidanceEnabled } from "../src/launch-guidance-settings.js";

/** A pool whose settings table holds exactly `stored`. */
function poolWith(stored: string | undefined): Pool {
  const query = vi.fn(async () =>
    stored === undefined
      ? { rows: [], rowCount: 0 }
      : { rows: [{ value: stored }], rowCount: 1 }
  );
  return { query } as unknown as Pool;
}

describe("trimmed launch guidance default", () => {
  // The default flipped without a migration, so "unset" is the case that
  // matters: it is what every existing install reads.
  it("is on when unset", async () => {
    await expect(
      isTrimmedLaunchGuidanceEnabled(poolWith(undefined))
    ).resolves.toBe(true);
  });

  it("honours an explicit false", async () => {
    await expect(
      isTrimmedLaunchGuidanceEnabled(poolWith("false"))
    ).resolves.toBe(false);
    await expect(
      isTrimmedLaunchGuidanceEnabled(poolWith("true"))
    ).resolves.toBe(true);
  });
});
