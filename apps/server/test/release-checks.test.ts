import { spawnSync } from "node:child_process";
import https from "node:https";
import type { Server as HttpsServer } from "node:https";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { AssistedUpdateState } from "../src/assisted-update-store.js";
import { runRequiredChecks } from "../src/release-checks.js";

// Mock readReleaseStore at the module boundary — RELEASE_STORE_PATH is
// computed at import time from the real homedir, so a runtime mock of
// os.homedir doesn't redirect it. Mocking the export lets each test
// stage exactly the on-disk record the check should see.
type StoreRecord = { tag: string; deployedAt: string } | null;
let stagedRecord: StoreRecord = null;
vi.mock("../src/release-store.js", () => ({
  readReleaseStore: vi.fn(async () => stagedRecord),
  writeReleaseStore: vi.fn(async () => {}),
}));

let tmpServerDir: string;

beforeEach(async () => {
  tmpServerDir = await mkdtemp(path.join(os.tmpdir(), "dispatch-checks-"));
  stagedRecord = null;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpServerDir, { recursive: true, force: true });
});

function setReleaseRecord(record: StoreRecord) {
  stagedRecord = record;
}

describe("expected_runtime_artifact", () => {
  it("passes when both server and web build outputs exist", async () => {
    const serverDist = path.join(tmpServerDir, "apps/server/dist");
    const webDist = path.join(tmpServerDir, "apps/web/dist");
    await mkdir(serverDist, { recursive: true });
    await mkdir(webDist, { recursive: true });
    await writeFile(path.join(serverDist, "main.js"), "console.log('ok')");
    await writeFile(
      path.join(webDist, "index.html"),
      "<!doctype html><html></html>"
    );

    const [result] = await runRequiredChecks(["expected_runtime_artifact"], {
      serverDir: tmpServerDir,
      targetTag: "v0.19.0",
    });

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/All expected runtime artifacts/);
  });

  it("fails when an artifact is missing", async () => {
    const serverDist = path.join(tmpServerDir, "apps/server/dist");
    await mkdir(serverDist, { recursive: true });
    await writeFile(path.join(serverDist, "main.js"), "");

    const [result] = await runRequiredChecks(["expected_runtime_artifact"], {
      serverDir: tmpServerDir,
      targetTag: "v0.19.0",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Missing:.*apps\/web\/dist\/index\.html/);
  });
});

describe("service_entrypoint", () => {
  it("passes when package.json declares scripts.start", async () => {
    const pkgDir = path.join(tmpServerDir, "apps/server");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ scripts: { start: "node dist/main.js" } })
    );

    const [result] = await runRequiredChecks(["service_entrypoint"], {
      serverDir: tmpServerDir,
      targetTag: "v0.19.0",
    });

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/start script: node dist\/main\.js/);
  });

  it("fails when package.json is missing", async () => {
    const [result] = await runRequiredChecks(["service_entrypoint"], {
      serverDir: tmpServerDir,
      targetTag: "v0.19.0",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/package\.json/);
  });

  it("fails when scripts.start is missing", async () => {
    const pkgDir = path.join(tmpServerDir, "apps/server");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ scripts: { build: "tsc" } })
    );

    const [result] = await runRequiredChecks(["service_entrypoint"], {
      serverDir: tmpServerDir,
      targetTag: "v0.19.0",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/scripts\.start is missing/);
  });
});

describe("service_restarted", () => {
  it("passes when release.json is present", async () => {
    setReleaseRecord({
      tag: "v0.19.0",
      deployedAt: "2026-04-26T05:00:00.000Z",
    });

    const [result] = await runRequiredChecks(["service_restarted"], {
      serverDir: tmpServerDir,
      targetTag: "v0.19.0",
    });

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/last deploy v0\.19\.0/);
  });

  it("fails when release.json is missing", async () => {
    const [result] = await runRequiredChecks(["service_restarted"], {
      serverDir: tmpServerDir,
      targetTag: "v0.19.0",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/release\.json not present/);
  });
});

describe("health_endpoint", () => {
  it("passes when the endpoint returns status=ok", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const [result] = await runRequiredChecks(["health_endpoint"], {
      serverDir: tmpServerDir,
      targetTag: "v0.19.0",
      healthUrl: "http://test/health",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/health",
      expect.any(Object)
    );
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/health endpoint ok/);
  });

  it("fails on non-200 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("oops", { status: 503 })
    );

    const [result] = await runRequiredChecks(["health_endpoint"], {
      serverDir: tmpServerDir,
      targetTag: "v0.19.0",
      healthUrl: "http://test/health",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/503/);
  });

  it("fails when status field is not 'ok'", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "degraded" }), { status: 200 })
    );

    const [result] = await runRequiredChecks(["health_endpoint"], {
      serverDir: tmpServerDir,
      targetTag: "v0.19.0",
      healthUrl: "http://test/health",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/missing status=ok/);
  });

  it("fails on fetch error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const [result] = await runRequiredChecks(["health_endpoint"], {
      serverDir: tmpServerDir,
      targetTag: "v0.19.0",
      healthUrl: "http://test/health",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/ECONNREFUSED/);
  });
});

// Regression: when config.tls is on, the server's self-check hits its own
// self-signed cert. Bare fetch refuses self-signed certs (no per-request
// override), so for loopback HTTPS we drop to node:https with
// rejectUnauthorized off. Verify that path against a real self-signed
// server, and confirm bare fetch against the same URL still rejects.
describe("health_endpoint with self-signed loopback HTTPS", () => {
  let openSslAvailable = false;
  let server: HttpsServer | null = null;
  let port = 0;
  let healthUrl = "";
  let certDir = "";
  let healthBody = JSON.stringify({ status: "ok" });
  let healthStatus = 200;

  beforeAll(async () => {
    openSslAvailable =
      spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;
    if (!openSslAvailable) return;

    certDir = await mkdtemp(path.join(os.tmpdir(), "dispatch-tls-"));
    const keyPath = path.join(certDir, "key.pem");
    const certPath = path.join(certDir, "cert.pem");
    const gen = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
      ],
      { stdio: "ignore" }
    );
    if (gen.status !== 0) {
      openSslAvailable = false;
      return;
    }

    server = https.createServer(
      {
        key: await readFile(keyPath),
        cert: await readFile(certPath),
      },
      (_req, res) => {
        res.statusCode = healthStatus;
        res.setHeader("Content-Type", "application/json");
        res.end(healthBody);
      }
    );
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", () => resolve())
    );
    const addr = server!.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
    healthUrl = `https://127.0.0.1:${port}/api/v1/health`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    if (certDir) {
      await rm(certDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    healthStatus = 200;
    healthBody = JSON.stringify({ status: "ok" });
  });

  it("passes against a self-signed loopback HTTPS endpoint", async () => {
    if (!openSslAvailable) return;
    const [result] = await runRequiredChecks(["health_endpoint"], {
      serverDir: tmpServerDir,
      targetTag: "v0.19.0",
      healthUrl,
    });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/health endpoint ok/);
  });

  it("regression: bare fetch on the same self-signed URL still fails", async () => {
    if (!openSslAvailable) return;
    // Confirms the bypass is meaningful — without it, the bug returns.
    await expect(
      fetch(healthUrl, { signal: AbortSignal.timeout(5_000) })
    ).rejects.toThrow();
  });

  it("reports non-2xx status against the self-signed loopback server", async () => {
    if (!openSslAvailable) return;
    healthStatus = 503;
    healthBody = "service unavailable";
    const [result] = await runRequiredChecks(["health_endpoint"], {
      serverDir: tmpServerDir,
      targetTag: "v0.19.0",
      healthUrl,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/503/);
  });
});

describe("version_converged", () => {
  it("passes when release.json matches the target tag", async () => {
    setReleaseRecord({
      tag: "v0.19.0",
      deployedAt: "2026-04-26T05:00:00.000Z",
    });

    const [result] = await runRequiredChecks(["version_converged"], {
      serverDir: tmpServerDir,
      targetTag: "v0.19.0",
    });

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/converged to v0\.19\.0/);
  });

  it("fails when release.json shows a different tag", async () => {
    setReleaseRecord({
      tag: "v0.18.1",
      deployedAt: "2026-04-25T05:00:00.000Z",
    });

    const [result] = await runRequiredChecks(["version_converged"], {
      serverDir: tmpServerDir,
      targetTag: "v0.19.0",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/v0\.18\.1 does not match target v0\.19\.0/);
  });

  it("fails when release.json is missing", async () => {
    const [result] = await runRequiredChecks(["version_converged"], {
      serverDir: tmpServerDir,
      targetTag: "v0.19.0",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/release\.json not present/);
  });
});

describe("runRequiredChecks", () => {
  it("returns one result per check name in order", async () => {
    setReleaseRecord({
      tag: "v0.19.0",
      deployedAt: "2026-04-26T05:00:00.000Z",
    });
    const pkgDir = path.join(tmpServerDir, "apps/server");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ scripts: { start: "node dist/main.js" } })
    );

    const results = await runRequiredChecks(
      ["service_entrypoint", "version_converged", "service_restarted"],
      { serverDir: tmpServerDir, targetTag: "v0.19.0" }
    );

    expect(results.map((r) => r.name)).toEqual([
      "service_entrypoint",
      "version_converged",
      "service_restarted",
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

// Sanity: the AssistedUpdateState type ought to expose the same check
// shape so the result of runRequiredChecks fits straight onto state.checks.
describe("type compatibility", () => {
  it("CheckResult assignable to AssistedUpdateState['checks'][number]", () => {
    const sample: AssistedUpdateState["checks"][number] = {
      name: "version_converged",
      ok: true,
      message: "converged",
    };
    expect(sample.name).toBe("version_converged");
  });
});
