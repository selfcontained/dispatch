import { Pool, types } from "pg";

import type { AppConfig } from "../config.js";

// Parse PostgreSQL bigint (OID 20) as JavaScript number instead of string.
// Warns if a value exceeds Number.MAX_SAFE_INTEGER (~9 quadrillion) where
// precision would be silently lost.
types.setTypeParser(20, (val) => {
  const n = Number(val);
  if (n > Number.MAX_SAFE_INTEGER) {
    console.warn("pg bigint exceeds MAX_SAFE_INTEGER, precision lost:", val);
  }
  return n;
});

export function createPool(config: AppConfig): Pool {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  // Prevent unhandled 'error' events on idle clients from crashing the process.
  // Connection errors during shutdown (e.g. pg_terminate_backend in tests) are
  // expected and safe to ignore — the pool will reconnect if needed.
  pool.on("error", () => {});
  return pool;
}

/**
 * Keep observability probes isolated from the application pool. Both acquiring
 * the single probe connection and reading a result are bounded by the driver;
 * ServiceResources adds its own watchdog and retires the client on timeout.
 */
export function createServiceResourcesProbePool(config: AppConfig): Pool {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 1,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_500,
    query_timeout: 2_500,
    allowExitOnIdle: true,
  });
  pool.on("error", () => {});
  return pool;
}
