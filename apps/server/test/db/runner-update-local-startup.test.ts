import { mkdtempSync, rmSync } from "node:fs";
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

it("starts the child before migrations without awaiting its readiness", async () => {
  await setupTestDb();
  root = mkdtempSync(join(tmpdir(), "dispatch-startup-"));
  vi.stubEnv("DATABASE_URL", getTestDatabaseUrl());
  vi.stubEnv("DISPATCH_AGENT_RUNTIME", "inert");
  vi.stubEnv("DISPATCH_AGENT_STATE_ROOT", root);
  vi.stubEnv("DISPATCH_STATE_DIR", root);
  vi.stubEnv("DISPATCH_FILES_ROOT", join(root, "files"));
  vi.stubEnv("DISPATCH_PORT", "0");
  vi.stubEnv("DISPATCH_HOST", "127.0.0.1");
  const local = await import("../../src/runners/local.js");
  const migration = await import("../../src/db/migrate.js");
  const spawn = vi.spyOn(local, "startLocalRunnerProcess");
  const migrate = migration.runMigrations;
  vi.spyOn(migration, "runMigrations").mockImplementation(async (...args) => {
    expect(spawn).toHaveBeenCalledOnce();
    await migrate(...args);
  });
  const server = await import("../../src/server.js");
  close = server.closeApp;
  await server.initializeApp({
    reconcileState: false,
    // A living child that never sends ready: startup must still finish.
    localRunner: { command: ["bun", "-e", "setInterval(() => {}, 1000)"] },
  });
  expect(spawn).toHaveBeenCalledOnce();
});
