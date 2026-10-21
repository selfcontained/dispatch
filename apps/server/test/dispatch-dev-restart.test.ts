import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
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

function fixture(running: "true" | "false" | "missing" | "error") {
  const dir = mkdtempSync("/tmp/dispatch-restart-regression-");
  const suffix = path.basename(dir);
  const state = `/tmp/dispatch-dev-${suffix}.env`;
  const logs = `/tmp/dispatch-dev-${suffix}`;
  cleanups.push(() => {
    for (const file of [dir, state, `${state}.restart-backup`, logs])
      rmSync(file, { recursive: true, force: true });
  });
  const tools = path.join(dir, "bin");
  mkdirSync(tools);
  const calls = path.join(dir, "docker-calls");
  // Model Moby #50133: the list snapshot still says running after stop,
  // while exact inspection reads the current (locked) container state.
  writeFileSync(
    path.join(tools, "docker"),
    `#!/bin/bash
printf '%s\\n' "$*" >> "$DOCKER_CALLS"
case "$1 $2" in
  'ps -q') echo stale-running-container ;;
  'container inspect')
    [ "$4" = '{{.State.Running}}' ] || exit 91
    [ "$5" = "dispatch-postgres-$TEST_SUFFIX" ] || exit 92
    [ "$TEST_RUNNING" != missing ] || { echo "No such container" >&2; exit 1; }
    [ "$TEST_RUNNING" != error ] || { echo "daemon unavailable" >&2; exit 1; }
    echo "$TEST_RUNNING"
    ;;
  'compose version') exit 0 ;;
  compose*) echo 'fixture: refusing to start real services' >&2; exit 42 ;;
  *) exit 93 ;;
esac
`,
    { mode: 0o755 }
  );
  const saved = [
    `DEV_SUFFIX=${suffix}`,
    `DEV_CWD=${dir}`,
    "DEV_DB_PORT=12345",
    "DEV_API_PID=",
    "DEV_VITE_PID=",
    `DEV_CONTAINER_SUFFIX=${suffix}`,
    `DEV_COMPOSE_PROJECT=dispatch-dev-${suffix}`,
    "DEV_NO_DB=0",
    "DEV_PRESERVE_AGENT_HOSTS=1",
    "",
  ].join("\n");
  writeFileSync(state, saved);
  const run = (command: "restart" | "status") =>
    spawnSync("/bin/bash", [bin, command, "--suffix", suffix], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tools}:${process.env.PATH}`,
        DOCKER_CALLS: calls,
        TEST_SUFFIX: suffix,
        TEST_RUNNING: running,
      },
    });
  return { run, calls, state, saved, logs };
}

function alive(child: ChildProcess): boolean {
  try {
    process.kill(child.pid!, 0);
    return true;
  } catch {
    return false;
  }
}

describe("dev database state after stop", () => {
  it.each(["false", "missing", "error"] as const)(
    "recovers a %s container despite a stale running list, preserving hosts",
    (running) => {
      const { run, calls, state, saved, logs } = fixture(running);
      const host = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        {
          stdio: "ignore",
        }
      );
      cleanups.push(() => host.kill());
      const agentDir = path.join(logs, "agents", "fixture-host");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(path.join(agentDir, "host.pid"), String(host.pid));

      const result = run("restart");
      expect(result.stdout).toContain(
        "recreating it without stopping agent hosts"
      );
      // Stop at Compose rather than launching services; recovery must keep
      // both the working host and the old cleanup state even on startup failure.
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain(
        "fixture: refusing to start real services"
      );
      expect(alive(host)).toBe(true);
      expect(readFileSync(state, "utf8")).toBe(saved);
      const dockerCalls = readFileSync(calls, "utf8");
      expect(dockerCalls).toContain("container inspect");
      expect(dockerCalls).not.toContain("down");
    }
  );

  it.each([
    ["true", "running"],
    ["false", "stopped"],
    ["missing", "stopped"],
    ["error", "stopped"],
  ] as const)("reports a %s container as %s", (running, status) => {
    const { run } = fixture(running);
    const result = run("status");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`db:   ${status}`);
  });
});
