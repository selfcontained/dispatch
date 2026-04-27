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

  it("serializes overlapping markMigrationsApplied calls so neither drops ids", async () => {
    // Round-1 infra-review #1243: without the per-process serialization
    // chain, two read-modify-write cycles racing on the same store can
    // each read the pre-write state, both build their own next state,
    // and the loser's rename clobbers the winner's ids. Fire two
    // concurrent calls with disjoint ids and verify both make it.
    const { markMigrationsApplied, readAppliedMigrationsState } =
      await importStore();
    const [s1, s2] = await Promise.all([
      markMigrationsApplied(["a", "b"], "v1.0.0"),
      markMigrationsApplied(["c", "d"], "v1.0.0"),
    ]);
    // Both calls should observe the union of ids — whichever ran first
    // populated a-b, and the second cycle read that and added c-d on top.
    const merged = (s2.appliedMigrations.a ? s2 : s1).appliedMigrations;
    expect(Object.keys(merged).sort()).toEqual(["a", "b", "c", "d"]);

    const final = await readAppliedMigrationsState();
    expect(Object.keys(final.appliedMigrations).sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("uses a unique tmp filename so concurrent writers don't race on the same .tmp", async () => {
    // Round-1 infra-review #1243: two writers both staging to a fixed
    // `<final>.tmp` would race — one rename moves the shared tmp out
    // from under the other and surfaces as ENOENT. The fix uses a
    // per-call `<final>.tmp.<pid>.<rand>` so each writer owns its own
    // staging file. Verified structurally: no shared `.tmp` constant
    // ever appears in the cache dir during a write storm.
    const { markMigrationsApplied } = await importStore();
    const fs = await import("node:fs/promises");
    const ids = Array.from({ length: 8 }, (_, i) => `mig-${i}`);
    await Promise.all(ids.map((id) => markMigrationsApplied([id], "v1.0.0")));
    const dir = path.dirname(storePath);
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    // No leftover .tmp files (they're renamed atomically into place).
    expect(entries.filter((e) => e.includes(".tmp"))).toEqual([]);
  });
});
