import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * End-to-end-ish smoke covering: cache hit → tarball extraction → manifest
 * parse → pending-migration evaluation → mark applied → re-evaluate sees
 * the change. The download path is sidestepped by pre-populating the
 * tarball cache, which exercises the full chain except the actual HTTPS
 * request — that's covered by the production deploy flow.
 */

let testRoot: string;
let cacheDir: string;
let appliedStorePath: string;

async function importAll() {
  return {
    cache: await import("../src/release-tarball-cache.js"),
    applied: await import("../src/applied-migrations-store.js"),
    evaluator: await import("../src/update-migrations-evaluator.js"),
  };
}

const MIGRATION_YAML = (id: string) => `id: ${id}
title: ${id} migration
summary: ${id} summary text
alreadySatisfied:
  description: ${id} already-satisfied check description
instructions:
  - ${id} step 1
  - ${id} step 2
validation:
  requiredChecks:
    - service_entrypoint
rollback:
  - ${id} rollback
`;

beforeEach(async () => {
  testRoot = await mkdtemp(path.join(os.tmpdir(), "dispatch-flow-smoke-"));
  cacheDir = path.join(testRoot, "cache");
  appliedStorePath = path.join(testRoot, "applied-migrations.json");
  process.env.DISPATCH_RELEASE_CACHE_DIR = cacheDir;
  process.env.DISPATCH_APPLIED_MIGRATIONS_STORE_PATH = appliedStorePath;
});

afterEach(async () => {
  delete process.env.DISPATCH_RELEASE_CACHE_DIR;
  delete process.env.DISPATCH_APPLIED_MIGRATIONS_STORE_PATH;
  await rm(testRoot, { recursive: true, force: true });
});

async function seedCacheTarball(
  tag: string,
  manifests: Array<{ filename: string; contents: string }>
): Promise<string> {
  const buildDir = await mkdtemp(path.join(testRoot, "build-"));
  const migrationsDir = path.join(buildDir, "update-migrations");
  await mkdir(migrationsDir, { recursive: true });
  for (const m of manifests) {
    await writeFile(path.join(migrationsDir, m.filename), m.contents, "utf-8");
  }
  const { cache } = await importAll();
  const tarballPath = cache.cachedTarballPath(tag);
  await mkdir(path.dirname(tarballPath), { recursive: true });
  execFileSync(
    "tar",
    ["czf", tarballPath, "-C", buildDir, "update-migrations"],
    { stdio: "pipe" }
  );
  return tarballPath;
}

describe("release flow smoke", () => {
  it("evaluatePendingMigrations returns ordered manifests for a cached tarball", async () => {
    const { evaluator } = await importAll();
    await seedCacheTarball("v0.18.13", [
      {
        filename: "0001-bun-cutover.yaml",
        contents: MIGRATION_YAML("bun-cutover"),
      },
      { filename: "0002-second.yaml", contents: MIGRATION_YAML("second") },
    ]);
    evaluator.clearEvaluatorCache();
    const result = await evaluator.evaluatePendingMigrations("v0.18.13", {
      repo: "owner/repo",
    });
    expect(result.pending.map((m) => m.manifest.id)).toEqual([
      "bun-cutover",
      "second",
    ]);
    expect(result.errors).toEqual([]);
  });

  it("filters out migrations already recorded in applied-state", async () => {
    const { applied, evaluator } = await importAll();
    await seedCacheTarball("v0.18.13", [
      { filename: "0001-first.yaml", contents: MIGRATION_YAML("first") },
      { filename: "0002-second.yaml", contents: MIGRATION_YAML("second") },
      { filename: "0003-third.yaml", contents: MIGRATION_YAML("third") },
    ]);
    await applied.markMigrationsApplied(["second"], "v0.18.12");

    evaluator.clearEvaluatorCache();
    const result = await evaluator.evaluatePendingMigrations("v0.18.13", {
      repo: "owner/repo",
    });
    expect(result.pending.map((m) => m.manifest.id)).toEqual([
      "first",
      "third",
    ]);
    expect(result.appliedIds.has("second")).toBe(true);
  });

  it("returns no pending after marking every migration applied + clearing memo", async () => {
    const { applied, evaluator } = await importAll();
    await seedCacheTarball("v0.18.13", [
      { filename: "0001-first.yaml", contents: MIGRATION_YAML("first") },
      { filename: "0002-second.yaml", contents: MIGRATION_YAML("second") },
    ]);
    evaluator.clearEvaluatorCache();
    let result = await evaluator.evaluatePendingMigrations("v0.18.13", {
      repo: "owner/repo",
    });
    expect(result.pending.map((m) => m.manifest.id)).toEqual([
      "first",
      "second",
    ]);

    await applied.markMigrationsApplied(["first", "second"], "v0.18.13");
    evaluator.clearEvaluatorCache();
    result = await evaluator.evaluatePendingMigrations("v0.18.13", {
      repo: "owner/repo",
    });
    expect(result.pending).toEqual([]);
  });

  it("memoizes per-tag results until clearEvaluatorCache is called", async () => {
    const { applied, evaluator } = await importAll();
    await seedCacheTarball("v0.18.13", [
      { filename: "0001-first.yaml", contents: MIGRATION_YAML("first") },
    ]);
    evaluator.clearEvaluatorCache();
    const first = await evaluator.evaluatePendingMigrations("v0.18.13", {
      repo: "owner/repo",
    });
    expect(first.pending.length).toBe(1);

    // Mark applied without clearing memo — second call should still see the
    // pending migration because the cached result hasn't been invalidated.
    await applied.markMigrationsApplied(["first"], "v0.18.13");
    const second = await evaluator.evaluatePendingMigrations("v0.18.13", {
      repo: "owner/repo",
    });
    expect(second.pending.length).toBe(1);

    // After clearing the memo, the next call re-reads applied-state and
    // sees the migration is no longer pending.
    evaluator.clearEvaluatorCache();
    const third = await evaluator.evaluatePendingMigrations("v0.18.13", {
      repo: "owner/repo",
    });
    expect(third.pending.length).toBe(0);
  });

  it("returns evaluation errors for malformed manifests without dropping the rest", async () => {
    const { evaluator } = await importAll();
    await seedCacheTarball("v0.18.13", [
      { filename: "0001-good.yaml", contents: MIGRATION_YAML("good") },
      { filename: "0002-bad.yaml", contents: "not: [valid yaml" },
    ]);
    evaluator.clearEvaluatorCache();
    const result = await evaluator.evaluatePendingMigrations("v0.18.13", {
      repo: "owner/repo",
    });
    expect(result.pending.map((m) => m.manifest.id)).toEqual(["good"]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]?.filename).toBe("0002-bad.yaml");
  });
});
