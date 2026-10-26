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

// Regression coverage for scripts/server-tests-isolated.sh:
//  - the old age-only `docker ps -a | ... | docker rm -f` survivor sweep is
//    gone (it had no ownership proof and left networks/volumes behind);
//  - a Compose teardown failure is reported instead of swallowed by
//    `2>/dev/null || true`, and forces a run that otherwise passed to fail
//    (while a run that was already failing keeps its own exit code);
//  - a failing run captures Postgres diagnostics before teardown;
//  - a SIGTERM/SIGINT sent to the script is forwarded to the running
//    vitest process (and waited on) instead of sitting pending until that
//    process finishes on its own.
// A fake `docker` on PATH stands in for the daemon so none of this needs a
// real one; `bun` is faked too so the script's final `bun x vitest` never
// actually runs the real suite.

const script = path.resolve(
  import.meta.dirname,
  "../../../scripts/server-tests-isolated.sh"
);
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(opts: { up?: string; down?: string; bun?: string } = {}) {
  const dir = mkdtempSync("/tmp/dispatch-servertest-regression-");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  const tools = path.join(dir, "bin");
  mkdirSync(tools);
  const calls = path.join(dir, "docker-calls");
  // Subcommands (up/down/logs/ls) are matched as whole words anywhere in
  // the arg list, since -f/-p flags come before them in the real call.
  writeFileSync(
    path.join(tools, "docker"),
    `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
case " $* " in
  *' ls '*) exit 0 ;;
  *' up '*) ${opts.up ?? "exit 0"} ;;
  *' down '*|*' down') ${opts.down ?? "exit 0"} ;;
  *' logs '*) echo 'fake postgres log line'; exit 0 ;;
  *' ps '*) echo "SWEEP STILL PRESENT: $*" >&2; exit 77 ;;
  *) echo "unexpected docker invocation: $*" >&2; exit 95 ;;
esac
`,
    { mode: 0o755 }
  );
  writeFileSync(
    path.join(tools, "bun"),
    `#!/bin/bash\n${opts.bun ?? "exit 0"}\n`,
    { mode: 0o755 }
  );

  const env = {
    ...process.env,
    PATH: `${tools}:${process.env.PATH}`,
    TEST_DATABASE_URL: "",
  };

  const run = (extraEnv: Record<string, string> = {}) =>
    spawnSync("/bin/bash", [script], {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...env, ...extraEnv },
    });

  const runAsync = () => spawn("/bin/bash", [script], { env });

  return { run, runAsync, calls, dir };
}

function readCalls(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
}

describe("server-tests-isolated.sh", () => {
  it("never runs a host-wide age-based docker ps sweep", () => {
    const { run, calls } = fixture();
    const result = run();

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("SWEEP STILL PRESENT");
    const lines = readCalls(calls);
    expect(lines.some((l) => l.includes("ps "))).toBe(false);
  });

  it("surfaces a Compose teardown failure instead of swallowing it, and fails a run that otherwise passed", () => {
    const { run } = fixture({
      down: "echo 'daemon unavailable' >&2; exit 1",
    });
    const result = run();

    // A passing suite must not report success while it leaked a container —
    // the teardown failure is reported AND forces the run to fail.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Warning: failed to tear down");
    expect(result.stderr).toContain("daemon unavailable");
    expect(result.stderr).toContain("Clean it up manually with");
    expect(result.stderr).toContain("the suite passed, but teardown did not");
  });

  it("preserves the original failing exit code when teardown ALSO fails", () => {
    const { run } = fixture({
      bun: "exit 7",
      down: "echo 'daemon unavailable' >&2; exit 1",
    });
    const result = run();

    // The suite's own failure is the one that matters; it must not be
    // masked by the secondary teardown failure's own exit status.
    expect(result.status).toBe(7);
    expect(result.stderr).toContain("Warning: failed to tear down");
    expect(result.stderr).not.toContain(
      "the suite passed, but teardown did not"
    );
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "forwards %s to the running vitest process and still tears down",
    async (signal) => {
      const signalDir = mkdtempSync("/tmp/dispatch-servertest-signal-");
      const signalLog = path.join(signalDir, "got-signal");
      const readyFile = path.join(signalDir, "ready");
      cleanups.push(() => rmSync(signalDir, { recursive: true, force: true }));
      const { runAsync, calls } = fixture({
        // A real Node process with its own signal handler, standing in for
        // vitest — unlike a bash `sleep`, it reacts to a forwarded signal
        // immediately instead of only after some blocking command returns.
        // It marks itself ready synchronously so the test can wait for the
        // handler to actually be registered rather than guessing a delay,
        // which would be flaky under load (parallel test-file contention).
        bun: `exec node -e '
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

      // The forwarded signal reached the real child quickly rather than
      // sitting pending until its own 30s sleep elapsed.
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

  it("bypasses Docker entirely when TEST_DATABASE_URL is already set", () => {
    const { run, calls } = fixture();
    const result = run({ TEST_DATABASE_URL: "postgres://example/db" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Using TEST_DATABASE_URL");
    expect(existsSync(calls)).toBe(false);
  });

  it("captures Postgres diagnostics before teardown when the test run fails", () => {
    const { run } = fixture({ bun: "exit 1" });
    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Run failed (exit 1); capturing Postgres diagnostics before teardown"
    );
    expect(result.stderr).toContain("fake postgres log line");
    expect(result.stdout).toContain("Tearing down isolated Postgres");
  });
});

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
