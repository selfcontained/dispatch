import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Each test gets its own store path so we can run them in parallel without
// stepping on a shared file. The module reads the env var lazily on every
// call, so we can rebind per test.
let testDir: string;
let storePath: string;

async function importStore() {
  // Re-import to ensure the env var is picked up. Vitest caches modules,
  // but reading APPLIED_MIGRATIONS_STORE_PATH from a getter at call time
  // means we don't need to reset the cache.
  return await import("../src/applied-migrations-store.js");
}

beforeEach(async () => {
  testDir = await mkdtemp(path.join(os.tmpdir(), "dispatch-applied-mig-"));
  storePath = path.join(testDir, "applied-migrations.json");
  process.env.DISPATCH_APPLIED_MIGRATIONS_STORE_PATH = storePath;
});

afterEach(async () => {
  delete process.env.DISPATCH_APPLIED_MIGRATIONS_STORE_PATH;
  await rm(testDir, { recursive: true, force: true });
});

describe("applied-migrations-store", () => {
  it("returns empty state when no file exists yet", async () => {
    const { readAppliedMigrationsState } = await importStore();
    const state = await readAppliedMigrationsState();
    expect(state).toEqual({ appliedMigrations: {} });
  });

  it("marks new migrations applied with timestamp + targetTag", async () => {
    const { markMigrationsApplied, readAppliedMigrationsState } =
      await importStore();
    const fixedNow = new Date("2026-04-27T14:12:00Z");
    await markMigrationsApplied(["bun-cutover"], "v0.18.13", () => fixedNow);
    const state = await readAppliedMigrationsState();
    expect(state.appliedMigrations["bun-cutover"]).toEqual({
      appliedAt: "2026-04-27T14:12:00.000Z",
      targetTag: "v0.18.13",
    });
  });

  it("is idempotent — re-marking an applied id does not overwrite the timestamp", async () => {
    const { markMigrationsApplied, readAppliedMigrationsState } =
      await importStore();
    const first = new Date("2026-04-27T14:12:00Z");
    const second = new Date("2026-05-01T00:00:00Z");
    await markMigrationsApplied(["bun-cutover"], "v0.18.13", () => first);
    await markMigrationsApplied(
      ["bun-cutover", "second-mig"],
      "v0.19.0",
      () => second
    );
    const state = await readAppliedMigrationsState();
    expect(state.appliedMigrations["bun-cutover"]?.targetTag).toBe("v0.18.13");
    expect(state.appliedMigrations["bun-cutover"]?.appliedAt).toBe(
      "2026-04-27T14:12:00.000Z"
    );
    expect(state.appliedMigrations["second-mig"]?.targetTag).toBe("v0.19.0");
  });

  it("persists atomically (no .tmp file left behind on success)", async () => {
    const { markMigrationsApplied } = await importStore();
    await markMigrationsApplied(["mig"], "v1.0.0");
    const written = await readFile(storePath, "utf-8");
    expect(written).toContain('"mig"');
    // The atomic-rename helper writes to <path>.tmp then renames; success
    // case must leave only the canonical file.
    let tmpExists = true;
    try {
      await readFile(`${storePath}.tmp`, "utf-8");
    } catch {
      tmpExists = false;
    }
    expect(tmpExists).toBe(false);
  });

  it("appliedIdSet returns the id key set", async () => {
    const { appliedIdSet, markMigrationsApplied, readAppliedMigrationsState } =
      await importStore();
    await markMigrationsApplied(["a", "b"], "v1.0.0");
    const ids = appliedIdSet(await readAppliedMigrationsState());
    expect([...ids].sort()).toEqual(["a", "b"]);
  });

  it("returns empty state for malformed JSON instead of throwing", async () => {
    const { readAppliedMigrationsState } = await importStore();
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, "{not valid json", "utf-8");
    const state = await readAppliedMigrationsState();
    expect(state).toEqual({ appliedMigrations: {} });
  });
});
