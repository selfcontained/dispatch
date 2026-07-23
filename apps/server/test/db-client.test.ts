import { describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import { createServiceResourcesProbePool } from "../src/db/client.js";

describe("service resources probe pool", () => {
  it("bounds connection acquisition and query execution", async () => {
    const pool = createServiceResourcesProbePool({
      databaseUrl: "postgres://dispatch:dispatch@127.0.0.1:1/dispatch",
    } as AppConfig);

    expect(pool.options).toMatchObject({
      max: 1,
      connectionTimeoutMillis: 2_500,
      query_timeout: 2_500,
    });

    await pool.end();
  });
});
