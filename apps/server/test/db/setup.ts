/**
 * Test database helpers.
 *
 * Creates an isolated test database per suite so tests don't interfere with
 * each other or the production database.
 */
import { Pool } from "pg";

import { runMigrations } from "../../src/db/migrate.js";

const ADMIN_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://dispatch:dispatch@127.0.0.1:5432/postgres";

let testDbName: string;
let adminPool: Pool;
let testPool: Pool;
let testDatabaseUrl: string;

/**
 * Create a fresh test database and return a connected pool.
 * Call this in `beforeAll`.
 */
export async function setupTestDb(): Promise<Pool> {
  testDbName = `dispatch_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  adminPool = new Pool({ connectionString: ADMIN_DATABASE_URL, max: 2 });
  adminPool.on("error", () => {});

  await adminPool.query(`CREATE DATABASE "${testDbName}"`);

  testDatabaseUrl = ADMIN_DATABASE_URL.replace(/\/[^/]+$/, `/${testDbName}`);
  testPool = new Pool({ connectionString: testDatabaseUrl, max: 5 });
  testPool.on("error", () => {});

  return testPool;
}

/**
 * Drop the test database. Call this in `afterAll`.
 */
export async function teardownTestDb(): Promise<void> {
  if (testPool) {
    await testPool.end();
  }
  if (adminPool && testDbName) {
    // Terminate remaining connections before drop
    await adminPool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [testDbName]
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
    await adminPool.end();
  }
}

/**
 * Run migrations against the test database using node-pg-migrate.
 */
export async function runTestMigrations(): Promise<void> {
  await runMigrations(testDatabaseUrl);
}
