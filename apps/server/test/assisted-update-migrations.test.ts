import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateMigrationManifest } from "../src/update-migrations.js";

let testDir: string;
let appliedStorePath: string;
let assistedStorePath: string;

async function importEverything() {
  return {
    assisted: await import("../src/assisted-update.js"),
    store: await import("../src/assisted-update-store.js"),
    applied: await import("../src/applied-migrations-store.js"),
    evaluator: await import("../src/update-migrations-evaluator.js"),
  };
}

beforeEach(async () => {
  testDir = await mkdtemp(path.join(os.tmpdir(), "dispatch-assisted-mig-"));
  appliedStorePath = path.join(testDir, "applied-migrations.json");
  assistedStorePath = path.join(testDir, "assisted-update.json");
  process.env.DISPATCH_APPLIED_MIGRATIONS_STORE_PATH = appliedStorePath;
  // assisted-update-store doesn't have an env override yet, so we mock
  // the path module if needed. For this suite we test the orchestrator
  // logic against module-loaded path; clear state by rming the file.
  await rm(assistedStorePath, { force: true }).catch(() => {});
});

afterEach(async () => {
  delete process.env.DISPATCH_APPLIED_MIGRATIONS_STORE_PATH;
  await rm(testDir, { recursive: true, force: true });
});

const RECOVERY = {
  serviceCommand: "launchctl kickstart -k gui/501/com.dispatch.server",
  healthEndpoint: "http://127.0.0.1:6767/api/v1/health",
  serviceLogPath: "~/.dispatch/logs/dispatch.log",
  failureLogPath: "~/.dispatch/logs/last-release-failure.log",
};

const MIGRATION = (id: string): UpdateMigrationManifest => ({
  id,
  title: `${id} migration`,
  summary: `${id} summary`,
  alreadySatisfied: { description: `${id} already satisfied` },
  instructions: [`${id} step 1`, `${id} step 2`],
  validation: {
    requiredChecks:
      id === "first" ? ["service_entrypoint"] : ["health_endpoint"],
  },
  rollback: [`${id} rollback step`],
});

describe("buildAssistedUpdateContext (migrations path)", () => {
  it("snapshots migrations into state and computes the union of required checks", async () => {
    const { assisted } = await importEverything();
    const ctx = await assisted.buildAssistedUpdateContext(
      {
        tag: "v0.18.13",
        fromTag: "v0.18.12",
        migrations: [MIGRATION("first"), MIGRATION("second")],
        serverDir: "/tmp/dispatch-test-server",
        recovery: RECOVERY,
      },
      "http://127.0.0.1:6767"
    );
    expect(ctx.state.migrations?.map((m) => m.id)).toEqual(["first", "second"]);
    expect(ctx.state.metadata).toBeNull();
    // Union: service_entrypoint from first + health_endpoint from second
    expect(ctx.state.requiredChecks.sort()).toEqual([
      "health_endpoint",
      "service_entrypoint",
    ]);
    expect(ctx.state.phase).toBe("inspect");
    expect(ctx.state.token.length).toBeGreaterThan(20);
  });

  it("dedupes overlapping required checks across migrations", async () => {
    const { assisted } = await importEverything();
    const overlap = (id: string): UpdateMigrationManifest => ({
      ...MIGRATION(id),
      validation: {
        requiredChecks: ["health_endpoint", "service_entrypoint"],
      },
    });
    const ctx = await assisted.buildAssistedUpdateContext(
      {
        tag: "v0.18.13",
        fromTag: null,
        migrations: [overlap("a"), overlap("b")],
        serverDir: "/tmp/dispatch-test-server",
        recovery: RECOVERY,
      },
      "http://127.0.0.1:6767"
    );
    expect(ctx.state.requiredChecks).toEqual([
      "health_endpoint",
      "service_entrypoint",
    ]);
  });

  it("renders a per-migration prompt section for every pending manifest", async () => {
    const { assisted } = await importEverything();
    const ctx = await assisted.buildAssistedUpdateContext(
      {
        tag: "v0.18.13",
        fromTag: "v0.18.12",
        migrations: [MIGRATION("first"), MIGRATION("second")],
        serverDir: "/tmp/dispatch-test-server",
        recovery: RECOVERY,
      },
      "http://127.0.0.1:6767"
    );
    expect(ctx.prompt).toContain("Pending migrations");
    expect(ctx.prompt).toContain("first migration");
    expect(ctx.prompt).toContain("second migration");
    expect(ctx.prompt).toContain("Already satisfied?");
    expect(ctx.prompt).toContain("first already satisfied");
    expect(ctx.prompt).toContain("first step 1");
    expect(ctx.prompt).toContain("Rollback");
    expect(ctx.prompt).toContain("first rollback step");
    expect(ctx.prompt).toContain("Migration 1/2");
    expect(ctx.prompt).toContain("Migration 2/2");
    // Per-migration validation checks listed
    expect(ctx.prompt).toMatch(/Validation checks for this migration/);
    expect(ctx.prompt).toContain("never invent a service");
  });

  it("falls back to the legacy metadata path when no migrations are passed", async () => {
    const { assisted } = await importEverything();
    const ctx = await assisted.buildAssistedUpdateContext(
      {
        tag: "v0.18.13",
        fromTag: "v0.18.12",
        metadata: {
          mode: "required",
          title: "Legacy block",
          summary: "A legacy single-block release",
          requiredChecks: ["health_endpoint"],
        },
        serverDir: "/tmp/dispatch-test-server",
        recovery: RECOVERY,
      },
      "http://127.0.0.1:6767"
    );
    expect(ctx.state.migrations).toBeNull();
    expect(ctx.state.metadata?.title).toBe("Legacy block");
    expect(ctx.state.requiredChecks).toEqual(["health_endpoint"]);
    expect(ctx.prompt).toContain("Legacy block");
    // Legacy header, not the migration header
    expect(ctx.prompt).not.toContain("Pending migrations");
  });

  it("rejects a build with neither migrations nor metadata", async () => {
    const { assisted } = await importEverything();
    await expect(
      assisted.buildAssistedUpdateContext(
        {
          tag: "v0.18.13",
          fromTag: null,
          serverDir: "/tmp/dispatch-test-server",
          recovery: RECOVERY,
        },
        "http://127.0.0.1:6767"
      )
    ).rejects.toThrow(/migrations or metadata/);
  });
});

describe("runAndRecordChecks (migrations path)", () => {
  it("marks every pending migration applied when all checks pass", async () => {
    const { assisted, applied } = await importEverything();
    const ctx = await assisted.buildAssistedUpdateContext(
      {
        tag: "v0.18.13",
        fromTag: "v0.18.12",
        migrations: [MIGRATION("first"), MIGRATION("second")],
        serverDir: "/tmp/dispatch-test-server",
        recovery: RECOVERY,
      },
      "http://127.0.0.1:6767"
    );

    // Stub the check runner so we don't actually shell out to tar etc.
    // The orchestrator path we want to verify is "all-pass → mark applied".
    const releaseChecks = await import("../src/release-checks.js");
    const runRequiredChecksSpy = vi
      .spyOn(releaseChecks, "runRequiredChecks")
      .mockResolvedValue(
        ctx.state.requiredChecks.map((name) => ({
          name,
          ok: true,
          message: `${name} passed`,
        }))
      );

    try {
      await assisted.runAndRecordChecks(ctx.state, {
        serverDir: "/tmp/dispatch-test-server",
        targetTag: "v0.18.13",
      });
    } finally {
      runRequiredChecksSpy.mockRestore();
    }

    const state = await applied.readAppliedMigrationsState();
    expect(Object.keys(state.appliedMigrations).sort()).toEqual([
      "first",
      "second",
    ]);
    expect(state.appliedMigrations.first?.targetTag).toBe("v0.18.13");
    expect(state.appliedMigrations.second?.targetTag).toBe("v0.18.13");
  });

  it("marks NO migrations applied when any check fails", async () => {
    const { assisted, applied } = await importEverything();
    const ctx = await assisted.buildAssistedUpdateContext(
      {
        tag: "v0.18.13",
        fromTag: "v0.18.12",
        migrations: [MIGRATION("first"), MIGRATION("second")],
        serverDir: "/tmp/dispatch-test-server",
        recovery: RECOVERY,
      },
      "http://127.0.0.1:6767"
    );

    const releaseChecks = await import("../src/release-checks.js");
    const spy = vi.spyOn(releaseChecks, "runRequiredChecks").mockResolvedValue([
      {
        name: ctx.state.requiredChecks[0]!,
        ok: false,
        message: "synthetic failure",
      },
      ...ctx.state.requiredChecks.slice(1).map((name) => ({
        name,
        ok: true,
        message: `${name} passed`,
      })),
    ]);

    try {
      await assisted.runAndRecordChecks(ctx.state, {
        serverDir: "/tmp/dispatch-test-server",
        targetTag: "v0.18.13",
      });
    } finally {
      spy.mockRestore();
    }

    const state = await applied.readAppliedMigrationsState();
    expect(state.appliedMigrations).toEqual({});
  });
});
