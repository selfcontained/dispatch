import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { setupTestDb, teardownTestDb, getTestDatabaseUrl } from "./setup.js";

let close: (() => Promise<void>) | undefined;
let root: string | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
  await teardownTestDb();
});

it("imports main-era live rows when the child is ready before upgrade migrations", async () => {
  const pool = await setupTestDb();
  root = mkdtempSync(join(tmpdir(), "dispatch-startup-upgrade-"));
  vi.stubEnv("DATABASE_URL", getTestDatabaseUrl());
  vi.stubEnv("DISPATCH_AGENT_RUNTIME", "inert");
  vi.stubEnv("DISPATCH_AGENT_STATE_ROOT", root);
  vi.stubEnv("DISPATCH_STATE_DIR", root);
  vi.stubEnv("DISPATCH_FILES_ROOT", join(root, "files"));
  vi.stubEnv("DISPATCH_PORT", "0");
  vi.stubEnv("DISPATCH_HOST", "127.0.0.1");
  const migration = await import("../../src/db/migrate.js");
  const { migrationFiles } =
    await import("../../src/generated/runtime-assets.js");
  // origin/main ends at 0052. Build that schema rather than pre-applying
  // this branch's DDL, then leave a live agent from the older build in it.
  await migration.runMigrations({
    databaseUrl: getTestDatabaseUrl(),
    count: migrationFiles.filter((m) => m.name.slice(0, 4) <= "0052").length,
  });
  await pool.query(
    "INSERT INTO agents (id, name, status, cwd) VALUES ('legacy-live', 'Legacy', 'running', $1)",
    [root]
  );
  await expect(
    pool.query("SELECT runner_id FROM agents")
  ).rejects.toMatchObject({ code: "42703" });
  const local = await import("../../src/runners/local.js");
  const bindings = await import("../../src/runners/local-bindings.js");
  let migrated = false;
  const readTimes: boolean[] = [];
  const stopTimes: boolean[] = [];
  const { AgentManager } = await import("../../src/agents/manager.js");
  vi.spyOn(AgentManager.prototype, "retryStopsOnReconnect").mockImplementation(
    () => {
      stopTimes.push(migrated);
    }
  );
  const read = bindings.readLocalBindings;
  vi.spyOn(bindings, "readLocalBindings").mockImplementation((...args) => {
    readTimes.push(migrated);
    return read(...args);
  });
  const requested = Promise.withResolvers<void>();
  const healthy = Promise.withResolvers<void>();
  const spawn = local.startLocalRunnerProcess;
  vi.spyOn(local, "startLocalRunnerProcess").mockImplementation((options) =>
    spawn({
      ...options,
      bindings: () => {
        requested.resolve();
        return options.bindings!();
      },
      onReady: () => {
        options.onReady?.();
        healthy.resolve();
      },
    })
  );
  const migrate = migration.runMigrations;
  vi.spyOn(migration, "runMigrations").mockImplementation(async (...args) => {
    // Force the real child's import and healthy callbacks to run while
    // the database is still at main's schema, independent of machine speed.
    await Promise.all([requested.promise, healthy.promise]);
    await migrate(...args);
    migrated = true;
  });
  const server = await import("../../src/server.js");
  close = server.closeApp;

  await server.initializeApp({
    reconcileState: false,
    localRunner: {
      command: [
        "bun",
        fileURLToPath(
          new URL("../fixtures/local-runner-entry.ts", import.meta.url)
        ),
        "local-runner",
      ],
    },
  });
  const stored = join(
    root,
    ".bindings",
    `${createHash("sha256").update("legacy-live").digest("hex")}.json`
  );
  await expect.poll(() => existsSync(stored), { timeout: 2000 }).toBe(true);
  expect(readTimes).toEqual([true]);
  expect(stopTimes).toEqual([true]);
});
