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
import {
  waitForFixturePid,
  writeProcessTreeFixture,
} from "./helpers/process-tree-fixture.js";

// Regression coverage for scripts/e2e-isolated.sh's teardown:
//  - compose up/down both now target this project's docker-compose.yml
//    explicitly, instead of relying on the caller's cwd to contain one;
//  - a Compose teardown failure is reported instead of swallowed by
//    `2>/dev/null || true`, and forces a run that otherwise passed to fail
//    (while a run that was already failing keeps its own exit code);
//  - a failing run captures Postgres diagnostics before teardown;
//  - a SIGTERM/SIGINT sent to the script is forwarded to the *whole* tree
//    the running Playwright process owns — including a forked worker the
//    launcher itself never signals — waited on with a bounded escalation
//    to SIGKILL for a stubborn survivor, without ever touching an
//    unrelated process that happens to share the same pgid.
// A fake `docker` on PATH stands in for the daemon; a fake `pnpm` makes the
// `playwright install chromium` step and `build:web` no-ops and lets the
// final Playwright invocation be controlled directly.

const script = path.resolve(
  import.meta.dirname,
  "../../../scripts/e2e-isolated.sh"
);
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(
  opts: { up?: string; down?: string; playwrightTest?: string } = {}
) {
  const dir = mkdtempSync("/tmp/dispatch-e2e-isolated-regression-");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  const tools = path.join(dir, "bin");
  mkdirSync(tools);
  const calls = path.join(dir, "docker-calls");
  writeFileSync(
    path.join(tools, "docker"),
    `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
case " $* " in
  *' version '*) exit 0 ;;
  *' up '*) ${opts.up ?? "echo 'generic docker failure' >&2; exit 1"} ;;
  *' down '*|*' down') ${opts.down ?? "exit 0"} ;;
  *' logs '*) echo 'fake postgres log line'; exit 0 ;;
  *) echo "unexpected docker invocation: $*" >&2; exit 95 ;;
esac
`,
    { mode: 0o755 }
  );
  writeFileSync(
    path.join(tools, "pnpm"),
    `#!/bin/bash
case "$*" in
  "exec playwright test"*) ${opts.playwrightTest ?? "exit 0"} ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 }
  );

  const env = {
    ...process.env,
    PATH: `${tools}:${process.env.PATH}`,
  };

  const run = () =>
    spawnSync("/bin/bash", [script], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 15_000,
      env,
    });

  const runAsync = () => spawn("/bin/bash", [script], { cwd: repoRoot, env });

  return { run, runAsync, calls };
}

function readCalls(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
}

function isCall(line: string, subcommand: string): boolean {
  return ` ${line} `.includes(` ${subcommand} `);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// By the time the wrapper script itself exits, its own bounded wait/kill
// loop has already confirmed the tree is gone — but this test process has
// no wait() relationship with that worker, so a just-killed PID can look
// briefly alive as an unreaped zombie. A short poll absorbs that without
// masking an actual survivor (the deadline still throws).
async function waitForPidDeath(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`pid ${pid} is still alive`);
}

async function waitForCallLine(
  file: string,
  subcommand: string
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (readCalls(file).some((l) => isCall(l, subcommand))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`"${subcommand}" was never recorded in ${file}`);
}

describe("e2e-isolated.sh teardown", () => {
  it("targets this project's docker-compose.yml explicitly on both up and down, regardless of cwd assumptions", () => {
    const { run, calls } = fixture();
    const result = run();

    expect(result.status).not.toBe(0);
    const lines = readCalls(calls);
    const upLine = lines.find((l) => isCall(l, "up"));
    const downLine = lines.find((l) => isCall(l, "down"));
    expect(upLine).toContain("-f");
    expect(upLine).toContain("docker-compose.yml");
    expect(downLine).toContain("-f");
    expect(downLine).toContain("docker-compose.yml");
    // down still runs even though up failed — teardown is unconditional.
    expect(downLine).toBeDefined();
  });

  it("surfaces a Compose teardown failure instead of swallowing it, and fails a run that otherwise passed", () => {
    const { run } = fixture({
      up: "exit 0",
      down: "echo 'daemon unavailable' >&2; exit 1",
    });
    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Warning: failed to tear down");
    expect(result.stderr).toContain("daemon unavailable");
    expect(result.stderr).toContain("Clean it up manually with");
    expect(result.stderr).toContain("the suite passed, but teardown did not");
  });

  it("preserves the original failing exit code when teardown ALSO fails", () => {
    const { run } = fixture({
      up: "exit 0",
      playwrightTest: "exit 7",
      down: "echo 'daemon unavailable' >&2; exit 1",
    });
    const result = run();

    expect(result.status).toBe(7);
    expect(result.stderr).toContain("Warning: failed to tear down");
    expect(result.stderr).not.toContain(
      "the suite passed, but teardown did not"
    );
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "forwards %s through to a worker the launcher forked but never itself signals, and still tears down",
    async (signal) => {
      // The launcher (standing in for Playwright's own CLI) has no signal
      // handler at all — it dies immediately on the forwarded signal via
      // Node's default disposition, exactly like a real launcher that
      // exits on TERM while a worker it forked keeps running. Reaching
      // the worker therefore requires signaling the whole tree, not just
      // the launcher's PID.
      const {
        launcherScript,
        markerFile,
        workerReadyFile,
        launcherReadyFile,
        dir,
      } = writeProcessTreeFixture({});
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
      const { runAsync, calls } = fixture({
        up: "exit 0",
        playwrightTest: `exec node ${launcherScript}`,
      });

      // An independent process, unrelated to the launcher/worker tree,
      // started directly by the test — proves the fix walks the owned
      // descendant tree rather than something broader (e.g. a pgid) that
      // could also catch a sibling process by accident.
      const sentinel = spawn("sleep", ["30"]);
      cleanups.push(() => sentinel.kill("SIGKILL"));

      const child = runAsync();
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });

      await waitForCallLine(calls, "up");
      const workerPid = await waitForFixturePid(workerReadyFile);
      expect(await waitForFixturePid(launcherReadyFile)).toBe(workerPid);
      child.kill(signal);

      const exitCode = await new Promise<number | null>((resolve) => {
        child.on("exit", (code) => resolve(code));
      });

      // The worker — never signaled by the launcher itself — still got the
      // forwarded signal and reacted to it gracefully, rather than being
      // left running or only reached via the slower SIGKILL escalation.
      expect(existsSync(markerFile)).toBe(true);
      expect(readFileSync(markerFile, "utf8")).toContain(`worker-${signal}`);
      await waitForPidDeath(workerPid);
      expect(exitCode).toBe(signal === "SIGINT" ? 130 : 143);
      expect(stderr).toContain(
        `Interrupted (${signal}); forwarding to the running test process`
      );
      const lines = readCalls(calls);
      expect(lines.some((l) => isCall(l, "down"))).toBe(true);

      // Unrelated to this run's own tree; must survive untouched.
      expect(isPidAlive(sentinel.pid!)).toBe(true);
    },
    20_000
  );

  it("escalates to SIGKILL for a worker that ignores the forwarded signal, without touching an unrelated process", async () => {
    const {
      launcherScript,
      markerFile,
      workerReadyFile,
      launcherReadyFile,
      dir,
    } = writeProcessTreeFixture({ stubbornWorker: true });
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const { runAsync, calls } = fixture({
      up: "exit 0",
      playwrightTest: `exec node ${launcherScript}`,
    });

    const sentinel = spawn("sleep", ["30"]);
    cleanups.push(() => sentinel.kill("SIGKILL"));

    const child = runAsync();
    await waitForCallLine(calls, "up");
    const workerPid = await waitForFixturePid(workerReadyFile);
    expect(await waitForFixturePid(launcherReadyFile)).toBe(workerPid);
    child.kill("SIGTERM");

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });

    // The worker ignored SIGTERM (no marker written), so only the bounded
    // escalation to SIGKILL could have ended it.
    expect(existsSync(markerFile)).toBe(false);
    await waitForPidDeath(workerPid);
    expect(exitCode).toBe(143);
    const lines = readCalls(calls);
    expect(lines.some((l) => isCall(l, "down"))).toBe(true);

    expect(isPidAlive(sentinel.pid!)).toBe(true);
  }, 20_000);

  it("captures Postgres diagnostics before teardown when the run fails", () => {
    const { run } = fixture();
    const result = run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `Run failed (exit ${result.status}); capturing Postgres diagnostics before teardown`
    );
    expect(result.stderr).toContain("fake postgres log line");
  });
});
