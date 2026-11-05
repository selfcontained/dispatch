import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const bin = path.resolve(import.meta.dirname, "../../../bin/dispatch-dev");
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

// Exercise the actual CLI against saved state and fail-closed tool doubles.
// No Docker container, API, Vite, provider CLI or agent host is started.
function fixture() {
  const dir = mkdtempSync("/tmp/dispatch-dev-contract-");
  const suffix = path.basename(dir);
  const state = `/tmp/dispatch-dev-${suffix}.env`;
  const logs = `/tmp/dispatch-dev-${suffix}`;
  const tools = path.join(dir, "bin");
  mkdirSync(tools);
  cleanups.push(() => {
    for (const target of [
      dir,
      state,
      logs,
      `${state}.restart-backup`,
      `${logs}.create-lock`,
    ])
      rmSync(target, { recursive: true, force: true });
  });
  const calls = path.join(dir, "calls");
  for (const tool of ["docker", "bun", "pnpm"]) {
    writeFileSync(
      path.join(tools, tool),
      `#!/bin/bash
printf '%s\\n' "${tool} $*" >> "$FIXTURE_CALLS"
if [ "${tool}" = docker ]; then
  case " $* " in
    *' compose version '*|*' down '*) exit 0 ;;
  esac
fi
if [ "${tool} $*" = "pnpm run dev" ]; then
  node -e 'const keys = ["DISPATCH_HOST", "DISPATCH_AGENT_RUNTIME", "DISPATCH_LOCAL_TLS", "DISPATCH_UPDATE_OWNER", "DISPATCH_MAC_INSTANCE_ID", "DISPATCH_LISTEN_HOSTS"]; console.log(JSON.stringify(Object.fromEntries(keys.map(k => [k, process.env[k] ?? null]))))'
fi
echo 'fixture: service startup forbidden' >&2
exit 42
`,
      { mode: 0o755 }
    );
  }
  const run = (...args: string[]) =>
    spawnSync("/bin/bash", [bin, ...args, "--suffix", suffix], {
      cwd: dir,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        PATH: `${tools}:${process.env.PATH}`,
        FIXTURE_CALLS: calls,
        DISPATCH_AGENT_ID: "",
        RESTART_API_PORT: "",
        RESTART_DB_PORT: "",
        RESTART_VITE_PORT: "",
        DISPATCH_HOST: "127.0.0.1",
        DISPATCH_LOCAL_TLS: "1",
        DISPATCH_UPDATE_OWNER: "macos-app",
        DISPATCH_MAC_INSTANCE_ID: "parent-instance",
        DISPATCH_LISTEN_HOSTS: "127.0.0.2",
      },
    });
  const save = (values: Record<string, string | number>) =>
    writeFileSync(
      state,
      Object.entries({
        DEV_SUFFIX: suffix,
        DEV_CWD: dir,
        DEV_NO_DB: 1,
        ...values,
      })
        .map(([key, value]) => `${key}=${value}`)
        .join("\n") + "\n"
    );
  return { dir, state, logs, calls, run, save };
}

describe("dispatch-dev isolated CLI contracts", () => {
  it("reports usage and an absent stack without invoking services", () => {
    const f = fixture();
    expect(f.run().stdout).toContain("Usage: dispatch-dev");
    const status = f.run("status");
    expect(status.status).toBe(0);
    expect(status.stdout).toContain("No dev environment found");
    expect(f.run("url").status).not.toBe(0);
    expect(existsSync(f.calls)).toBe(false);
  });

  it("refuses duplicate startup before invoking any service", () => {
    const f = fixture();
    f.save({ DEV_API_PID: process.pid, DEV_API_PORT: 12345 });
    const before = readFileSync(f.state, "utf8");
    const result = f.run("up");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("already running");
    expect(readFileSync(f.state, "utf8")).toBe(before);
    expect(existsSync(f.calls)).toBe(false);
  });

  it("renders status, URL and logs from saved state without booting services", () => {
    const f = fixture();
    f.save({
      DEV_API_PID: process.pid,
      DEV_API_PORT: 12345,
      DEV_VITE_PID: process.pid,
      DEV_VITE_PORT: 23456,
      DEV_DISPLAY_HOST: "192.0.2.10",
      DEV_RELEASE_CACHE_DIR: `${f.dir}/cache`,
    });
    const status = f.run("status");
    expect(status.status).toBe(0);
    expect(status.stdout).toContain("api:  running — http://192.0.2.10:12345");
    expect(status.stdout).toContain("vite: running — http://192.0.2.10:23456");
    expect(status.stdout).toContain(`release cache: ${f.dir}/cache`);
    expect(f.run("url").stdout.trim()).toBe("http://192.0.2.10:12345");
    mkdirSync(f.logs);
    writeFileSync(path.join(f.logs, "api.log"), "fixture log entry\n");
    expect(f.run("logs").stdout).toContain("fixture log entry");
    expect(existsSync(f.calls)).toBe(false);
  });

  it("clears stale tracking before attempting a fresh database startup", () => {
    const f = fixture();
    // Empty PID is deterministically dead; never risk targeting an arbitrary PID.
    f.save({ DEV_API_PID: "", DEV_VITE_PID: "" });
    const result = f.run("up");
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Cleaning stale state");
    expect(result.stdout).toContain("fixture: service startup forbidden");
    expect(existsSync(f.state)).toBe(false);
    const calls = readFileSync(f.calls, "utf8");
    expect(calls).toContain(" up -d --wait");
    expect(calls).not.toContain("pnpm");
  });

  it.each(["127.0.0.1", "0.0.0.0"])(
    "passes checkout host %s and strips installed-app settings",
    (host) => {
      const f = fixture();
      writeFileSync(path.join(f.dir, ".env"), `DISPATCH_HOST=${host}\n`);
      const result = f.run("up", "--no-db", "--no-seed");
      expect(result.status).not.toBe(0);
      const log = readFileSync(path.join(f.logs, "api.log"), "utf8");
      expect(JSON.parse(log.split("\n")[0]!)).toEqual({
        DISPATCH_HOST: host,
        DISPATCH_AGENT_RUNTIME: "inert",
        DISPATCH_LOCAL_TLS: null,
        DISPATCH_UPDATE_OWNER: null,
        DISPATCH_MAC_INSTANCE_ID: null,
        DISPATCH_LISTEN_HOSTS: null,
      });
      expect(log).toContain("fixture: service startup forbidden");
      expect(readFileSync(f.calls, "utf8").trim()).toBe("pnpm run dev");
    }
  );
});
