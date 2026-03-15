import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, rmSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(REPO_ROOT, "bin", "dispatch-dev");
const SUFFIX = `test-${process.pid}-${Date.now()}`;
const STATE_FILE = `/tmp/dispatch-dev-${SUFFIX}.env`;
const LOG_DIR = `/tmp/dispatch-dev-${SUFFIX}`;

function run(args: string, options?: { expectFail?: boolean }): string {
  try {
    return execSync(`${BIN} ${args}${args ? " " : ""}--suffix ${SUFFIX}`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Clear agent ID so it doesn't leak into suffix
        DISPATCH_AGENT_ID: "",
        HOSTESS_AGENT_ID: ""
      }
    }).trim();
  } catch (error) {
    if (options?.expectFail) {
      const err = error as { stderr?: string; stdout?: string };
      // Combine stdout + stderr since the script writes to both
      return `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim();
    }
    throw error;
  }
}

describe("dispatch-dev", () => {
  afterAll(() => {
    // Ensure cleanup even if tests fail
    try {
      run("down");
    } catch {
      // already down
    }
  });

  it("shows usage when no command is given", () => {
    const output = run("", { expectFail: true });
    expect(output).toContain("Usage: dispatch-dev");
  });

  it("reports nothing when status called with no stack", () => {
    const output = run("status");
    expect(output).toContain("No dev environment found");
  });

  it("starts and stops a full stack", () => {
    // --- up ---
    const upOutput = run("up");
    expect(upOutput).toContain("Database ready on port");
    expect(upOutput).toContain("API server starting on port");
    expect(upOutput).toContain("Vite dev server starting on port");
    expect(upOutput).toContain("Dev environment ready");

    // State file written
    expect(existsSync(STATE_FILE)).toBe(true);
    const state = readFileSync(STATE_FILE, "utf8");
    expect(state).toContain(`DEV_SUFFIX=${SUFFIX}`);
    expect(state).toMatch(/DEV_API_PORT=\d+/);
    expect(state).toMatch(/DEV_API_PID=\d+/);
    expect(state).toMatch(/DEV_DB_PORT=\d+/);

    // --- status ---
    const statusOutput = run("status");
    expect(statusOutput).toContain("db:   running");
    expect(statusOutput).toContain("api:  running");
    expect(statusOutput).toContain("vite:");

    // --- url ---
    const urlOutput = run("url");
    expect(urlOutput).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // --- logs ---
    const logsOutput = run("logs");
    expect(logsOutput.length).toBeGreaterThan(0);

    // --- down ---
    const downOutput = run("down");
    expect(downOutput).toContain("Stopped API server");
    expect(downOutput).toContain("Removed database container");
    expect(downOutput).toContain("Dev environment torn down");

    // State file cleaned
    expect(existsSync(STATE_FILE)).toBe(false);
    expect(existsSync(LOG_DIR)).toBe(false);
  }, 60_000);

  it("refuses to start a second stack with the same suffix", () => {
    try {
      run("up");
      const output = run("up", { expectFail: true });
      expect(output).toContain("already running");
    } finally {
      run("down");
    }
  }, 60_000);

  it("cleans stale state on up", () => {
    // Create a fake state file with a dead PID
    const fakeState = [
      `DEV_SUFFIX=${SUFFIX}`,
      "DEV_CWD=/tmp",
      "DEV_DB_PORT=1",
      "DEV_API_PORT=1",
      "DEV_API_PID=99999",
      "DEV_CONTAINER_SUFFIX=",
      "DEV_COMPOSE_PROJECT=",
      "DEV_NO_DB=1"
    ].join("\n");
    require("node:fs").writeFileSync(STATE_FILE, fakeState);

    try {
      const output = run("up --no-db");
      expect(output).toContain("Cleaning stale state");
      expect(output).toContain("API server starting on port");
    } finally {
      run("down");
    }
  }, 60_000);
});
