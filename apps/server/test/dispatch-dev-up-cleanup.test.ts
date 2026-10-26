import { spawn, spawnSync } from "node:child_process";
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

// Regression coverage for the gap where a fresh `dispatch-dev up` only
// writes its state file at the very end: a Compose or API failure (or an
// interrupt) before that point used to leave a container/network running
// with nothing for `down` to find. These tests fail a brand-new `up` before
// it ever reaches the API/Vite stages, using a fake `docker` on PATH so no
// real Docker, bun, or pnpm is needed.

const bin = path.resolve(import.meta.dirname, "../../../bin/dispatch-dev");
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(opts: { up?: string; down?: string } = {}) {
  const dir = mkdtempSync("/tmp/dispatch-up-cleanup-regression-");
  const suffix = path.basename(dir);
  const state = `/tmp/dispatch-dev-${suffix}.env`;
  const logDir = `/tmp/dispatch-dev-${suffix}`;
  const lockDir = `/tmp/dispatch-dev-${suffix}.create-lock`;
  cleanups.push(() => {
    for (const target of [dir, state, logDir, lockDir])
      rmSync(target, { recursive: true, force: true });
  });

  const tools = path.join(dir, "bin");
  mkdirSync(tools);
  const calls = path.join(dir, "docker-calls");
  // Flags (-f/-p) come before the subcommand in the real invocation
  // (`docker compose -f <file> -p <project> up -d --wait`), so the
  // subcommand is matched as a whole word anywhere in the arg list rather
  // than by position.
  writeFileSync(
    path.join(tools, "docker"),
    `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
case " $* " in
  *' version '*) exit 0 ;;
  *' up '*) ${opts.up ?? "echo 'generic docker failure' >&2; exit 1"} ;;
  *' down '*|*' down') ${opts.down ?? "exit 0"} ;;
  *) echo "unexpected docker invocation: $*" >&2; exit 95 ;;
esac
`,
    { mode: 0o755 }
  );
  // The preflight check only needs these to resolve, never to run real work.
  for (const name of ["pnpm", "bun"]) {
    writeFileSync(path.join(tools, name), "#!/bin/bash\nexit 0\n", {
      mode: 0o755,
    });
  }

  const env = {
    ...process.env,
    PATH: `${tools}:${process.env.PATH}`,
    DISPATCH_AGENT_ID: "",
    RESTART_API_PORT: "",
    RESTART_DB_PORT: "",
    RESTART_VITE_PORT: "",
  };

  const runSync = (extraEnv: Record<string, string> = {}) =>
    spawnSync("/bin/bash", [bin, "up", "--suffix", suffix], {
      cwd: dir,
      encoding: "utf8",
      timeout: 15_000,
      env: { ...env, ...extraEnv },
    });

  const runAsync = () =>
    spawn("/bin/bash", [bin, "up", "--suffix", suffix], {
      cwd: dir,
      env,
    });

  return { runSync, runAsync, calls, suffix, state, lockDir };
}

function readCalls(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
}

// The subcommand sits after the -f/-p flags (`compose -f <file> -p <project>
// up -d --wait`), so it is matched as a whole word rather than a prefix.
function isCall(line: string, subcommand: string): boolean {
  return ` ${line} `.includes(` ${subcommand} `);
}

describe("dispatch-dev up: fresh-create Compose cleanup", () => {
  it("releases the container/network it just created when the database never comes up", () => {
    const { runSync, calls, state } = fixture();
    const result = runSync();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Cleaning up Compose resources this run created"
    );

    const lines = readCalls(calls);
    const upIndex = lines.findIndex((l) => isCall(l, "up"));
    const downIndex = lines.findIndex((l) => isCall(l, "down"));
    expect(upIndex).toBeGreaterThanOrEqual(0);
    expect(downIndex).toBeGreaterThan(upIndex);
    // Only the container/network go — the named volume (and any data on it)
    // is never touched by a failed fresh create. (The worktree path itself
    // can contain the substring "-v", so check it as a discrete flag token.)
    expect(lines[downIndex]!.split(/\s+/)).not.toContain("-v");

    // No trackable state existed before, and the cleanup makes it moot:
    // nothing is left behind for `down` to find.
    expect(existsSync(state)).toBe(false);
  });

  it("surfaces a cleanup failure instead of silently discarding it, and saves retryable state", () => {
    const { runSync, state, suffix } = fixture({
      down: "echo 'daemon unavailable' >&2; exit 1",
    });
    const result = runSync();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "could not remove the container/network it started"
    );
    expect(result.stderr).toContain(
      `dispatch-dev down --suffix ${suffix}' can retry it`
    );
    // A failed cleanup is not the end of the story: unlike the happy-path
    // cleanup case above (nothing left to track), this one saves state so
    // a plain `down` afterward has something to find and retry against.
    expect(existsSync(state)).toBe(true);
    expect(readFileSync(state, "utf8")).toContain(
      `DEV_COMPOSE_PROJECT=dispatch-dev-${suffix}`
    );
  });

  it("detects a concurrent sibling that finished while this run waited for the lock", async () => {
    // Holding the lock directory ourselves stands in for a sibling `up`
    // still inside its own fresh-create window.
    const { runAsync, calls, suffix, state, lockDir } = fixture();
    mkdirSync(lockDir);
    writeFileSync(path.join(lockDir, "pid"), String(process.pid));

    const child = runAsync();
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    // Give the waiting loop a couple of ticks, then simulate the sibling
    // finishing: it releases the lock, and its state file now exists —
    // exactly what this run's post-lock recheck exists to notice.
    await new Promise((resolve) => setTimeout(resolve, 300));
    rmSync(lockDir, { recursive: true, force: true });
    writeFileSync(state, `DEV_SUFFIX=${suffix}\nDEV_API_PID=\n`);

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(
      "created by a concurrent 'up' while this one waited for its lock"
    );
    // Bailed before ever touching Docker — the sibling's own container is
    // never recreated or torn down underneath it.
    expect(existsSync(calls)).toBe(false);
    expect(readFileSync(state, "utf8")).toContain(`DEV_SUFFIX=${suffix}`);
  });

  it("does not touch Compose resources when a restart-driven recreate fails", () => {
    // RESTART_DB_PORT set is exactly how cmd_restart invokes cmd_up when
    // reusing an existing project; its own state-file backup/restore is the
    // recovery path, and this must never also run compose down underneath it.
    const { runSync, calls } = fixture();
    const result = runSync({ RESTART_DB_PORT: "54321" });

    expect(result.status).not.toBe(0);
    const lines = readCalls(calls);
    expect(lines.some((l) => isCall(l, "up"))).toBe(true);
    expect(lines.some((l) => isCall(l, "down"))).toBe(false);
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "cleans up and exits with the right code on %s while creating a fresh stack",
    async (signal) => {
      // "sleep 5" models docker compose genuinely blocking on `--wait`. bash
      // only runs a pending trap once its *current* foreground command
      // returns, so the signal must also reach that direct child (as a
      // real terminal Ctrl-C would, via the whole process group) for the
      // interrupt to land promptly instead of after the full sleep.
      const { runAsync, calls } = fixture({ up: "sleep 5; exit 0" });
      const child = runAsync();
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });

      await waitForCallLine(calls, "up");
      const directChild = spawnSync(
        "/bin/sh",
        ["-c", `pgrep -P ${child.pid} | head -n1`],
        { encoding: "utf8" }
      ).stdout.trim();
      if (directChild) process.kill(Number(directChild), signal);
      child.kill(signal);

      const exitCode = await new Promise<number | null>((resolve) => {
        child.on("exit", (code) => resolve(code));
      });

      expect(exitCode).toBe(signal === "SIGINT" ? 130 : 143);
      expect(stderr).toContain(`Interrupted (${signal})`);
      const lines = readCalls(calls);
      expect(lines.some((l) => isCall(l, "down"))).toBe(true);
    },
    10_000
  );

  it("lets a second fresh `up` for the same suffix proceed only after the first releases its lock", () => {
    // The first run fails fast (default fixture behavior) and must release
    // its create-lock as part of the same cleanup path, or a subsequent `up`
    // for the identical suffix would wedge for up to 30s waiting on it.
    const { runSync, lockDir } = fixture();
    const first = runSync();
    expect(first.status).not.toBe(0);
    expect(existsSync(lockDir)).toBe(false);

    const second = runSync();
    expect(second.status).not.toBe(0);
    expect(second.stderr).not.toContain("already creating the stack");
  });

  it("stops its own already-running API process when a later step fails", async () => {
    // Models the gap where only Compose was cleaned up centrally: the
    // browser-extension packaging step runs *after* the API is already up,
    // so a failure there used to abort via plain `set -e` with the live API
    // process never stopped. A fake `pnpm run dev` binds the real API port
    // (so the liveness check passes without a real server) and blocks;
    // a fake `pnpm --filter @dispatch/browser-extension package` fails.
    const dir = mkdtempSync("/tmp/dispatch-up-cleanup-regression-");
    const suffix = path.basename(dir);
    const state = `/tmp/dispatch-dev-${suffix}.env`;
    const logDir = `/tmp/dispatch-dev-${suffix}`;
    const lockDir = `/tmp/dispatch-dev-${suffix}.create-lock`;
    cleanups.push(() => {
      for (const target of [dir, state, logDir, lockDir])
        rmSync(target, { recursive: true, force: true });
    });

    const tools = path.join(dir, "bin");
    mkdirSync(tools);
    writeFileSync(
      path.join(tools, "docker"),
      `#!/bin/bash
case " $* " in
  *' version '*|*' up '*|*' down '*) exit 0 ;;
  *' down') exit 0 ;;
  *) echo "unexpected docker invocation: $*" >&2; exit 95 ;;
esac
`,
      { mode: 0o755 }
    );
    writeFileSync(path.join(tools, "bun"), "#!/bin/bash\nexit 0\n", {
      mode: 0o755,
    });
    writeFileSync(
      path.join(tools, "pnpm"),
      `#!/bin/bash
case "$*" in
  "run dev")
    # A real HTTP response (not just an open TCP port) so the health-check
    # curl succeeds on its first try instead of exhausting its own -m 2
    # timeout across 10 attempts.
    exec node -e "require('http').createServer((_, res) => res.end('{\\"status\\":\\"ok\\"}')).listen(Number(process.env.DISPATCH_PORT), '127.0.0.1')"
    ;;
  *"browser-extension package"*)
    echo "fixture: extension packaging failed" >&2
    exit 1
    ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 }
    );

    const env = {
      ...process.env,
      PATH: `${tools}:${process.env.PATH}`,
      DISPATCH_AGENT_ID: "",
      RESTART_API_PORT: "",
      RESTART_DB_PORT: "",
      RESTART_VITE_PORT: "",
      DISPATCH_HOST: "127.0.0.1",
    };
    const result = spawnSync(
      "/bin/bash",
      [bin, "up", "--suffix", suffix, "--no-seed"],
      { cwd: dir, encoding: "utf8", timeout: 25_000, env }
    );

    expect(result.status).not.toBe(0);
    // The packaging step's own output (including the fixture's failure
    // message) is redirected to vite.log by cmd_up itself, not inherited
    // onto the script's stderr — only its *exit status* trips `set -e`.
    expect(readFileSync(path.join(logDir, "vite.log"), "utf8")).toContain(
      "fixture: extension packaging failed"
    );
    const apiPidLine = result.stdout
      .split("\n")
      .find((l) => l.includes("API server starting on port"));
    expect(apiPidLine).toBeDefined();
    const apiPid = Number(apiPidLine!.match(/PID (\d+)/)![1]);
    expect(result.stdout).toContain(`Stopped API server (PID ${apiPid})`);
    expect(() => process.kill(apiPid, 0)).toThrow();
  }, 30_000);
});

async function waitForCallLine(
  file: string,
  subcommand: string
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (readCalls(file).some((l) => isCall(l, subcommand))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`"${subcommand}" was never recorded in ${file}`);
}
