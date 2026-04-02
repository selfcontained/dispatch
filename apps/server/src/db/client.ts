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
  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000
  });
}
