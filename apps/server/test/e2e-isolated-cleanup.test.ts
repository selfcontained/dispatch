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

// Regression coverage for scripts/e2e-isolated.sh's teardown:
//  - compose up/down both now target this project's docker-compose.yml
//    explicitly, instead of relying on the caller's cwd to contain one;
//  - a Compose teardown failure is reported instead of swallowed by
//    `2>/dev/null || true`, and forces a run that otherwise passed to fail
//    (while a run that was already failing keeps its own exit code);
//  - a failing run captures Postgres diagnostics before teardown;
//  - a SIGTERM/SIGINT sent to the script is forwarded to the running
//    Playwright process (and waited on) instead of sitting pending until
//    that process finishes on its own.
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

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${file} was never created`);
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
    "forwards %s to the running Playwright process and still tears down",
    async (signal) => {
      const signalDir = mkdtempSync("/tmp/dispatch-e2e-isolated-signal-");
      const signalLog = path.join(signalDir, "got-signal");
      const readyFile = path.join(signalDir, "ready");
      cleanups.push(() => rmSync(signalDir, { recursive: true, force: true }));
      const { runAsync, calls } = fixture({
        up: "exit 0",
        // A real Node process with its own signal handler, standing in for
        // Playwright — unlike a bash `sleep`, it reacts to a forwarded
        // signal immediately instead of only after some blocking command
        // returns (bash defers a pending trap until its current foreground
        // command exits on its own). It marks itself ready synchronously so
        // the test can wait for the handler to actually be registered
        // rather than guessing a delay, which would be flaky under load.
        playwrightTest: `exec node -e '
process.on(${JSON.stringify(signal)}, () => {
  require("fs").appendFileSync(${JSON.stringify(signalLog)}, "got-${signal}\\n");
  process.exit(1);
});
require("fs").writeFileSync(${JSON.stringify(readyFile)}, "ready");
setTimeout(() => {}, 30000);
'`,
      });

      const child = runAsync();
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });

      await waitForCallLine(calls, "up");
      await waitForFile(readyFile);
      child.kill(signal);

      const exitCode = await new Promise<number | null>((resolve) => {
        child.on("exit", (code) => resolve(code));
      });

      expect(existsSync(signalLog)).toBe(true);
      expect(readFileSync(signalLog, "utf8")).toContain(`got-${signal}`);
      expect(exitCode).toBe(signal === "SIGINT" ? 130 : 143);
      expect(stderr).toContain(
        `Interrupted (${signal}); forwarding to the running test process`
      );
      const lines = readCalls(calls);
      expect(lines.some((l) => isCall(l, "down"))).toBe(true);
    },
    20_000
  );

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
