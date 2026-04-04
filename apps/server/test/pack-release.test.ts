import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const BIN = path.join(REPO_ROOT, "bin", "pack-release");
const OUTPUT = `/tmp/dispatch-pack-release-test-${process.pid}.tar.gz`;

const BUILDS_EXIST =
  existsSync(path.join(REPO_ROOT, "apps/server/dist")) &&
  existsSync(path.join(REPO_ROOT, "apps/web/dist")) &&
  existsSync(path.join(REPO_ROOT, "packages/shared/dist"));

function run(args = ""): string {
  return execSync(`${BIN} ${args}`, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function tarList(): string[] {
  return execSync(`tar tzf "${OUTPUT}"`, { encoding: "utf8" })
    .trim()
    .split("\n");
}

// These tests require pre-built dist/ directories. In CI the test step runs
// before the build step, so we skip gracefully. The release workflow validates
// pack-release after building.
describe.skipIf(!BUILDS_EXIST)("pack-release", () => {

  afterAll(() => {
    if (existsSync(OUTPUT)) rmSync(OUTPUT);
  });

  it("produces a tarball with all required files", () => {
    const output = run(`--output "${OUTPUT}"`);
    expect(output).toContain("packed release artifact");
    expect(existsSync(OUTPUT)).toBe(true);
  });

  it("includes pre-built dist directories", () => {
    const files = tarList();
    expect(files.some((f) => f.startsWith("apps/server/dist/"))).toBe(true);
    expect(files.some((f) => f.startsWith("apps/web/dist/"))).toBe(true);
    expect(files.some((f) => f.startsWith("packages/shared/dist/"))).toBe(true);
  });

  it("includes package.json files for dependency install", () => {
    const files = tarList();
    expect(files).toContain("package.json");
    expect(files).toContain("apps/server/package.json");
    expect(files).toContain("apps/web/package.json");
    expect(files).toContain("packages/shared/package.json");
  });

  it("includes pnpm workspace config and lockfile", () => {
    const files = tarList();
    expect(files).toContain("pnpm-lock.yaml");
    expect(files).toContain("pnpm-workspace.yaml");
  });

  it("includes .nvmrc", () => {
    const files = tarList();
    expect(files).toContain(".nvmrc");
  });

  it("includes bin/ scripts", () => {
    const files = tarList();
    expect(files.some((f) => f.startsWith("bin/"))).toBe(true);
    expect(files.some((f) => f.includes("dispatch-deploy"))).toBe(true);
    expect(files.some((f) => f.includes("dispatch-server"))).toBe(true);
    expect(files.some((f) => f.includes("dispatch-launchd-wrapper"))).toBe(true);
  });

  it("includes database migrations", () => {
    const files = tarList();
    expect(
      files.some((f) => f.startsWith("apps/server/src/db/migrations/"))
    ).toBe(true);
  });

  it("includes release notes when present", () => {
    const files = tarList();
    // release-notes/current.md is generated during release; may or may not exist locally
    if (existsSync(path.join(REPO_ROOT, "release-notes/current.md"))) {
      expect(files).toContain("release-notes/current.md");
    }
  });

  it("does NOT include node_modules", () => {
    const files = tarList();
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
  });

  it("does NOT include source .ts files (except migrations and declarations)", () => {
    const files = tarList();
    const tsFiles = files.filter(
      (f) =>
        f.endsWith(".ts") &&
        !f.endsWith(".d.ts") &&
        !f.includes("migrations/")
    );
    expect(tsFiles).toEqual([]);
  });

  it("fails when build outputs are missing", () => {
    // Create a temporary directory without build outputs
    const tmpDir = `/tmp/dispatch-pack-release-empty-${process.pid}`;
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(path.join(tmpDir, "bin"), { recursive: true });
    writeFileSync(
      path.join(tmpDir, "bin/pack-release"),
      execSync(`cat "${BIN}"`, { encoding: "utf8" })
    );
    execSync(`chmod +x "${tmpDir}/bin/pack-release"`);
    // Create minimal files so the script can run
    writeFileSync(path.join(tmpDir, "package.json"), "{}");

    try {
      execSync(`${tmpDir}/bin/pack-release --output /tmp/should-not-exist.tar.gz`, {
        cwd: tmpDir,
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect.fail("should have thrown");
    } catch (error) {
      const err = error as { stderr?: string };
      expect(err.stderr).toContain("missing build outputs");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
