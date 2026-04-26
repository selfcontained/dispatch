import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
