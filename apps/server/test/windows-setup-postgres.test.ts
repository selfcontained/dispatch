import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import {
  adminUrl,
  maskPassword,
  probeTcp,
  provisionDatabase,
  testConnection,
} from "../src/windows-setup/postgres.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe("maskPassword", () => {
  it("hides only the password", () => {
    expect(maskPassword("postgres://u:secret@h:5432/d")).toBe(
      "postgres://u:•••@h:5432/d"
    );
  });
});

describe("adminUrl", () => {
  it("connects as postgres to the postgres database", () => {
    expect(adminUrl({ host: "127.0.0.1", port: 5432, password: "p@ss" })).toBe(
      "postgres://postgres:p%40ss@127.0.0.1:5432/postgres"
    );
  });
});

describe.skipIf(!testDatabaseUrl)("provisioning", () => {
  const admin = new URL(testDatabaseUrl ?? "postgres://x");
  const host = admin.hostname;
  const port = Number(admin.port || 5432);
  const suffix = randomBytes(4).toString("hex");
  const role = `ws_role_${suffix}`;
  const database = `ws_db_${suffix}`;

  async function adminQuery<T>(sql: string, values: unknown[] = []) {
    const client = new Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      return (await client.query(sql, values)).rows as T[];
    } finally {
      await client.end();
    }
  }

  afterAll(async () => {
    for (const name of [database, `${database}_x`])
      await adminQuery(`DROP DATABASE IF EXISTS "${name}"`);
    for (const name of [role, `${role}_x`])
      await adminQuery(`DROP ROLE IF EXISTS "${name}"`);
  });

  it("creates role and database and returns a working URL", async () => {
    const { databaseUrl } = await provisionDatabase({
      adminUrl: testDatabaseUrl!,
      host,
      port,
      role,
      database,
      password: "first",
    });
    expect(databaseUrl).toBe(
      `postgres://${role}:first@${host}:${port}/${database}`
    );
    await expect(testConnection(databaseUrl)).resolves.toBeUndefined();
  });

  it("resets the password of an existing role", async () => {
    await provisionDatabase({
      adminUrl: testDatabaseUrl!,
      host,
      port,
      role,
      database,
      password: "first",
    });
    const { databaseUrl } = await provisionDatabase({
      adminUrl: testDatabaseUrl!,
      host,
      port,
      role,
      database,
      password: "second",
    });
    await expect(testConnection(databaseUrl)).resolves.toBeUndefined();
  });

  it("rejects a wrong admin password without side effects", async () => {
    const wrong = new URL(testDatabaseUrl!);
    wrong.username = "ws_nobody";
    wrong.password = "wrong";
    await expect(
      provisionDatabase({
        adminUrl: wrong.toString(),
        host,
        port,
        role: `${role}_x`,
        database: `${database}_x`,
      })
    ).rejects.toThrow(/password|authentication|role/i);
    expect(
      await adminQuery("SELECT 1 FROM pg_roles WHERE rolname = $1", [
        `${role}_x`,
      ])
    ).toEqual([]);
  });

  it("tests an external URL as given", async () => {
    const pw = "p@ss:w/rd#1";
    await provisionDatabase({
      adminUrl: testDatabaseUrl!,
      host,
      port,
      role,
      database,
      password: pw,
    });
    await expect(
      testConnection(
        `postgres://${role}:${encodeURIComponent(pw)}@${host}:${port}/${database}`
      )
    ).resolves.toBeUndefined();
    // Loopback may use trust auth, so a wrong password is not a reliable
    // failure; a missing role fails under every auth configuration.
    await expect(
      testConnection(`postgres://ws_nobody:nope@${host}:${port}/${database}`)
    ).rejects.toThrow(/ws_nobody/);
  });

  it("probeTcp answers true for the test server and false for a closed port", async () => {
    expect(await probeTcp(host, port)).toBe(true);
    expect(await probeTcp("127.0.0.1", 1, 300)).toBe(false);
  });
});
