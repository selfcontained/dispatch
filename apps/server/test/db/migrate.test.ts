import { describe, expect, it } from "vitest";

import { shouldLogMigrationMessage } from "../../src/db/migrate.js";

describe("migration log filtering", () => {
  it("suppresses node-pg-migrate timestamp parse noise for numeric prefixes", () => {
    expect(
      shouldLogMigrationMessage("Can't determine timestamp for 0001")
    ).toBe(false);
  });

  it("keeps real migration messages", () => {
    expect(shouldLogMigrationMessage("Running migration 0001_baseline")).toBe(
      true
    );
  });
});
