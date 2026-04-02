import { Pool, types } from "pg";

import type { AppConfig } from "../config.js";

// Parse PostgreSQL bigint (OID 20) as JavaScript number instead of string.
// Safe for values up to Number.MAX_SAFE_INTEGER (~9 quadrillion).
types.setTypeParser(20, (val) => Number(val));

export function createPool(config: AppConfig): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000
  });
}
