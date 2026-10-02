import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const bin = path.resolve(import.meta.dirname, "../../../bin/dispatch-dev");
const dirs: string[] = [];
const states: string[] = [];
afterEach(() => {
  for (const file of states.splice(0)) rmSync(file, { force: true });
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fixture(docker?: string) {
  const dir = mkdtempSync("/tmp/dispatch-cleanup-regression-");
  dirs.push(dir);
  const tools = path.join(dir, "bin");
  mkdirSync(tools);
  // Deliberately omit Node, pnpm, and real Docker from the service PATH.
  for (const name of ["bash", "dirname", "rm"]) {
    const resolved = spawnSync("/bin/sh", ["-c", `command -v ${name}`], {
      encoding: "utf8",
    }).stdout.trim();
    symlinkSync(resolved, path.join(tools, name));
  }
  if (docker)
    writeFileSync(path.join(tools, "docker"), `#!/bin/bash\n${docker}\n`, {
      mode: 0o755,
    });
  const suffix = path.basename(dir);
  const state = `/tmp/dispatch-dev-${suffix}.env`;
  states.push(state);
  writeFileSync(
    state,
    `DEV_SUFFIX=${suffix}\nDEV_COMPOSE_PROJECT=${suffix}\nDEV_NO_DB=0\n`
  );
  const run = (wipe = false) =>
    spawnSync(
      "/bin/bash",
      [bin, "down", "--suffix", suffix, ...(wipe ? ["--wipe"] : [])],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: tools },
      }
    );
  return { run, state };
}

describe("dev teardown from a minimal service environment", () => {
  it("removes a database without requiring Node or pnpm", () => {
    const { run, state } = fixture("exit 0");
    const result = run(true);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Removed database container");
    expect(existsSync(state)).toBe(false);
  });
  it("keeps database volumes unless wipe is requested", () => {
    const { run, state } = fixture(
      'for arg in "$@"; do [ "$arg" != -v ] || exit 42; done\nexit 0'
    );
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("data kept");
    expect(existsSync(state)).toBe(false);
  });
  it("preserves tracking state when Docker is unavailable", () => {
    const { run, state } = fixture();
    const before = readFileSync(state, "utf8");
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Docker Compose is unavailable");
    expect(readFileSync(state, "utf8")).toBe(before);
  });
  it("preserves state and exposes Docker teardown errors", () => {
    const { run, state } = fixture(
      'if [ "$2" = version ]; then exit 0; fi\necho "daemon unavailable" >&2\nexit 1'
    );
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("daemon unavailable");
    expect(result.stderr).toContain("retained state");
    expect(existsSync(state)).toBe(true);
    expect(result.stdout).not.toContain("Removed database container");
  });
});
