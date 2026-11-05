import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

test("CI fails a retry-pass and writes first-attempt results", () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-playwright-policy-"));
  try {
    const output = join(dir, "results.json");
    writeFileSync(
      join(dir, "policy.spec.ts"),
      `import { test, expect } from ${JSON.stringify(require.resolve("@playwright/test"))};\ntest("diagnostic retry", async ({}, info) => { expect(info.retry).toBe(1); });\n`
    );
    writeFileSync(
      join(dir, "playwright.config.ts"),
      `import base from ${JSON.stringify(resolve("playwright.config.ts"))};\nexport default { ...base, testDir: ${JSON.stringify(dir)}, webServer: undefined, projects: [{ name: "policy" }], reporter: [["json", { outputFile: ${JSON.stringify(output)} }]], outputDir: ${JSON.stringify(join(dir, "artifacts"))} };\n`
    );
    const result = spawnSync(
      process.execPath,
      [
        require.resolve("@playwright/test/cli"),
        "test",
        "--config",
        join(dir, "playwright.config.ts"),
      ],
      {
        encoding: "utf8",
        env: { ...process.env, CI: "1" },
        timeout: 30_000,
      }
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(report.stats.flaky, 1);
    assert.deepEqual(
      report.suites[0].specs[0].tests[0].results.map((item) => item.status),
      ["failed", "passed"]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
