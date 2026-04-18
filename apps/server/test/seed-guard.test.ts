import { describe, expect, it } from "vitest";

import { seedDevData } from "../src/db/seed/index.js";

// Dummy pool that would explode if actually used — the guard should reject
// before any connect call happens.
const sentinelPool = {
  connect: () => {
    throw new Error("pool.connect should never run when the guard rejects");
  },
} as unknown as import("pg").Pool;

describe("seedDevData safety guard", () => {
  const mediaRoot = "/tmp/seed-guard-test";

  it.each([
    "postgres://u:p@host/dispatch",
    "postgres://u:p@host/dispatch_prod",
    "postgres://u:p@host/postgres",
    "postgres://u:p@host/app",
    "postgres://u:p@host/",
  ])("refuses to seed non-dev database %s", async (url) => {
    await expect(
      seedDevData(sentinelPool, {
        databaseUrl: url,
        mediaRoot,
        log: () => {},
      })
    ).rejects.toThrow(/Refusing to seed/);
  });

  it("refuses to seed when DATABASE_URL cannot be parsed", async () => {
    await expect(
      seedDevData(sentinelPool, {
        databaseUrl: "not a url",
        mediaRoot,
        log: () => {},
      })
    ).rejects.toThrow(/Refusing to seed/);
  });

  it("passes the guard for dispatch_<suffix> databases", async () => {
    // We expect the sentinel pool to blow up only after the guard passes,
    // which is our signal that the guard allowed the URL through.
    await expect(
      seedDevData(sentinelPool, {
        databaseUrl: "postgres://u:p@host/dispatch_agt_abc123",
        mediaRoot,
        log: () => {},
      })
    ).rejects.toThrow(/pool\.connect should never run/);
  });
});
