import { describe, expect, it } from "vitest";

import {
  assertSafeDatabaseConfig,
  assertSafePortConfig,
} from "../src/config.js";

describe("database safety config", () => {
  it.each([
    "postgres://dispatch@localhost/.",
    "postgres://dispatch@localhost/%2e%2e",
    "postgres://dispatch@localhost/.%2E",
    "postgres://dispatch@localhost/%2E.",
    "postgres://dispatch@localhost/",
    "postgres://tester@localhost/dispatch",
    "postgres://tester@localhost/%64ispatch",
    "postgres://tester@localhost/postgres",
  ])("rejects unsafe effective app database: %s", (databaseUrl) => {
    expect(() =>
      assertSafeDatabaseConfig(
        { databaseUrl },
        {
          DISPATCH_UPDATE_OWNER: "macos-app",
          DISPATCH_ALLOW_AGENT_PROD_DB: "1",
        }
      )
    ).toThrow("explicit, dedicated database");
  });

  it("accepts a dedicated app database using the actual pg parser", () => {
    expect(() =>
      assertSafeDatabaseConfig(
        { databaseUrl: "postgres://dispatch@localhost/preview" },
        { DISPATCH_UPDATE_OWNER: "macos-app" }
      )
    ).not.toThrow();
  });
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
        {
          databaseUrl:
            "postgres://dispatch:dispatch@127.0.0.1:5433/dispatch_agt_test",
        },
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
  it("refuses the production port for app previews outside an agent context", () => {
    expect(() =>
      assertSafePortConfig(
        { port: 6767 },
        { DISPATCH_UPDATE_OWNER: "macos-app" }
      )
    ).toThrow("cannot bind to production port");
  });
  it("refuses production port 6767 from an agent context", () => {
    expect(() =>
      assertSafePortConfig({ port: 6767 }, { DISPATCH_AGENT_ID: "agt_test" })
    ).toThrow("Refusing to bind to production port 6767");
  });

  it("allows non-production ports from an agent context", () => {
    expect(() =>
      assertSafePortConfig({ port: 9123 }, { DISPATCH_AGENT_ID: "agt_test" })
    ).not.toThrow();
  });

  it("allows production port outside agent context", () => {
    expect(() => assertSafePortConfig({ port: 6767 }, {})).not.toThrow();
  });
});
