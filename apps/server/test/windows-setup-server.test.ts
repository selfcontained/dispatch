import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildSetupEnv, parseEnvFile } from "../src/windows-setup/env-file.js";
import {
  createSetupApp,
  type SetupDeps,
} from "../src/windows-setup/setup-server.js";

const DATABASE_URL = "postgres://dispatch:secret@127.0.0.1:5432/dispatch";

describe("setup server", () => {
  let installDir: string;
  let postgres: {
    probeTcp: ReturnType<typeof vi.fn>;
    provisionDatabase: ReturnType<typeof vi.fn>;
    testConnection: ReturnType<typeof vi.fn>;
  };
  let fs: { copyFileSync: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    installDir = mkdtempSync(path.join(os.tmpdir(), "dispatch-setup-test-"));
    postgres = {
      probeTcp: vi.fn(async () => true),
      provisionDatabase: vi.fn(async () => ({ databaseUrl: DATABASE_URL })),
      testConnection: vi.fn(async () => undefined),
    };
    fs = { copyFileSync: vi.fn() };
  });

  afterEach(() => {
    rmSync(installDir, { recursive: true, force: true });
  });

  function makeApp(overrides: Partial<SetupDeps> = {}) {
    return createSetupApp({
      installDir,
      execPath: "/usr/local/bin/bun",
      platform: "linux",
      version: "1.4.5",
      postgres: postgres as never,
      fs: fs as never,
      isPortFree: async () => true,
      fetchHealth: async () => true,
      ...overrides,
    });
  }

  async function provision(app: ReturnType<typeof makeApp>["app"]) {
    return app.inject({
      method: "POST",
      url: "/api/setup/postgres/provision",
      payload: { host: "127.0.0.1", port: 5432, adminPassword: "pw" },
    });
  }

  it("serves the page and redirects / to /setup", async () => {
    const { app } = makeApp();
    const page = await app.inject({ method: "GET", url: "/setup" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toMatch(/text\/html/);
    expect(page.body).toContain('data-step="welcome"');
    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(302);
    expect(root.headers.location).toBe("/setup");
  });

  it("reports state with the probe result", async () => {
    const { app } = makeApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/setup/state",
    });
    expect(response.json()).toEqual({
      version: "1.4.5",
      installDir,
      postgres: { host: "127.0.0.1", port: 5432, reachable: true },
    });
    expect(postgres.probeTcp).toHaveBeenCalledWith("127.0.0.1", 5432);
  });

  it("probes a chosen host and port", async () => {
    postgres.probeTcp.mockResolvedValueOnce(false);
    const { app } = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/setup/postgres/probe",
      payload: { host: "db.local", port: 5444 },
    });
    expect(response.json()).toEqual({ reachable: false });
    expect(postgres.probeTcp).toHaveBeenCalledWith("db.local", 5444);
  });

  it("provisions with admin credentials and masks the password", async () => {
    const { app } = makeApp();
    const response = await provision(app);
    expect(response.statusCode).toBe(200);
    expect(postgres.provisionDatabase).toHaveBeenCalledWith({
      adminUrl: "postgres://postgres:pw@127.0.0.1:5432/postgres",
      host: "127.0.0.1",
      port: 5432,
    });
    expect(response.json()).toEqual({
      masked: "postgres://dispatch:•••@127.0.0.1:5432/dispatch",
    });
  });

  it("accepts an external connection URL after testing it", async () => {
    const { app } = makeApp();
    const ok = await app.inject({
      method: "POST",
      url: "/api/setup/postgres/provision",
      payload: { connectionUrl: "postgres://me:pw@db:5432/mine" },
    });
    expect(ok.statusCode).toBe(200);
    expect(postgres.testConnection).toHaveBeenCalledWith(
      "postgres://me:pw@db:5432/mine"
    );
    expect(ok.json()).toEqual({ masked: "postgres://me:•••@db:5432/mine" });

    postgres.testConnection.mockRejectedValueOnce(
      new Error('password authentication failed for user "me"')
    );
    const bad = await app.inject({
      method: "POST",
      url: "/api/setup/postgres/provision",
      payload: { connectionUrl: "postgres://me:nope@db:5432/mine" },
    });
    expect(bad.statusCode).toBe(502);
    expect(bad.json()).toEqual({
      error: 'password authentication failed for user "me"',
    });
  });

  it("refuses to install before a database is provisioned", async () => {
    const { app } = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/setup/install",
      payload: { port: 6767, listenOnLan: false },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/PostgreSQL/);
  });

  it("rejects a busy port before writing anything", async () => {
    const { app } = makeApp({ isPortFree: async () => false });
    await provision(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/setup/install",
      payload: { port: 6767, listenOnLan: false },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/6767/);
    expect(existsSync(path.join(installDir, ".env"))).toBe(false);
  });

  it("writes .env and resolves installed", async () => {
    const { app, installed } = makeApp();
    await provision(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/setup/install",
      payload: { port: 6767, listenOnLan: false },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ url: "http://127.0.0.1:6767" });
    const expected = buildSetupEnv({
      databaseUrl: DATABASE_URL,
      port: 6767,
      installDir,
    });
    expect(
      parseEnvFile(readFileSync(path.join(installDir, ".env"), "utf8"))
    ).toEqual(expected);
    await expect(installed).resolves.toEqual(expected);
    expect(fs.copyFileSync).not.toHaveBeenCalled();
  });

  it("copies the exe on Windows when running from elsewhere", async () => {
    const execPath = "D:\\Downloads\\dispatch-1.4.5-bun-windows-x64.exe";
    const { app } = makeApp({ platform: "win32", execPath });
    await provision(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/setup/install",
      payload: { port: 6767, listenOnLan: false },
    });
    expect(response.statusCode).toBe(200);
    expect(fs.copyFileSync).toHaveBeenCalledWith(
      execPath,
      path.join(installDir, "dispatch.exe")
    );
  });

  it("proxies the installed health check", async () => {
    const { app } = makeApp({
      fetchHealth: async (url) => {
        if (url === "http://127.0.0.1:6767/api/v1/health") return true;
        throw new Error("connection refused");
      },
    });
    const ok = await app.inject({
      method: "GET",
      url: "/api/setup/health?port=6767",
    });
    expect(ok.json()).toEqual({ ok: true });
    const down = await app.inject({
      method: "GET",
      url: "/api/setup/health?port=6768",
    });
    expect(down.json()).toEqual({ ok: false });
  });
});
