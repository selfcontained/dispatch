import { describe, expect, it } from "vitest";

import { assertSafeDatabaseConfig, assertSafePortConfig } from "../src/config.js";

describe("database safety config", () => {
  it("refuses the production database from a Dispatch agent context", () => {
    expect(() =>
      assertSafeDatabaseConfig(
        { databaseUrl: "postgres://dispatch:dispatch@127.0.0.1:5432/dispatch" },
        { DISPATCH_AGENT_ID: "agt_test" }
      )
    ).toThrow("Refusing to use the production 'dispatch' database");
  });

  it("allows isolated dispatch-dev databases from a Dispatch agent context", () => {
    expect(() =>
      assertSafeDatabaseConfig(
        { databaseUrl: "postgres://dispatch:dispatch@127.0.0.1:5433/dispatch_agt_test" },
        { DISPATCH_AGENT_ID: "agt_test" }
      )
    ).not.toThrow();
  });

  it("allows an explicit production override", () => {
    expect(() =>
      assertSafeDatabaseConfig(
        { databaseUrl: "postgres://dispatch:dispatch@127.0.0.1:5432/dispatch" },
        { DISPATCH_AGENT_ID: "agt_test", DISPATCH_ALLOW_AGENT_PROD_DB: "1" }
      )
    ).not.toThrow();
  });
});

describe("port safety config", () => {
  it("refuses production port 6767 from an agent context", () => {
    expect(() =>
      assertSafePortConfig({ port: 6767 }, { DISPATCH_AGENT_ID: "agt_test" })
    ).toThrow("Refusing to bind to production port 6767");
  });

  it("refuses production port 6767 from a dev server context", () => {
    expect(() =>
      assertSafePortConfig({ port: 6767 }, { DISPATCH_SESSION_PREFIX: "dispatch_dev" })
    ).toThrow("Refusing to bind to production port 6767");
  });

  it("allows non-production ports from an agent context", () => {
    expect(() =>
      assertSafePortConfig({ port: 9123 }, { DISPATCH_AGENT_ID: "agt_test" })
    ).not.toThrow();
  });

  it("allows production port outside agent/dev context", () => {
    expect(() =>
      assertSafePortConfig({ port: 6767 }, {})
    ).not.toThrow();
  });
});
