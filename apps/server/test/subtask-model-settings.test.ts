import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { isSubtaskModelDownshiftEnabled } from "../src/subtask-model-settings.js";

/** A pool whose settings table holds exactly `stored`. */
function poolWith(stored: string | undefined): Pool {
  const query = vi.fn(async () =>
    stored === undefined
      ? { rows: [], rowCount: 0 }
      : { rows: [{ value: stored }], rowCount: 1 }
  );
  return { query } as unknown as Pool;
}

describe("subtask model downshift default", () => {
  it("is on when unset", async () => {
    await expect(
      isSubtaskModelDownshiftEnabled(poolWith(undefined))
    ).resolves.toBe(true);
  });

  it("honours an explicit false", async () => {
    await expect(
      isSubtaskModelDownshiftEnabled(poolWith("false"))
    ).resolves.toBe(false);
  });
});
