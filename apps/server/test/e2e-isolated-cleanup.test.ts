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

// Regression coverage for scripts/e2e-isolated.sh's teardown:
//  - compose up/down both now target this project's docker-compose.yml
//    explicitly, instead of relying on the caller's cwd to contain one;
//  - a Compose teardown failure is reported instead of swallowed by
//    `2>/dev/null || true`;
//  - a failing run captures Postgres diagnostics before teardown.
// A fake `docker` on PATH stands in for the daemon; a fake `pnpm` makes the
// `playwright install chromium` step (which runs before Compose even
// starts) a no-op, since a failing `compose up` aborts the script before
// build:web or the actual Playwright run — neither needs faking here.

const script = path.resolve(
  import.meta.dirname,
  "../../../scripts/e2e-isolated.sh"
);
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(opts: { up?: string; down?: string } = {}) {
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
  writeFileSync(path.join(tools, "pnpm"), "#!/bin/bash\nexit 0\n", {
    mode: 0o755,
  });

  const run = () =>
    spawnSync("/bin/bash", [script], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${tools}:${process.env.PATH}`,
      },
    });

  return { run, calls };
}

function readCalls(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
}

function isCall(line: string, subcommand: string): boolean {
  return ` ${line} `.includes(` ${subcommand} `);
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

  it("surfaces a Compose teardown failure instead of swallowing it", () => {
    const { run } = fixture({
      down: "echo 'daemon unavailable' >&2; exit 1",
    });
    const result = run();

    expect(result.stderr).toContain("Warning: failed to tear down");
    expect(result.stderr).toContain("daemon unavailable");
    expect(result.stderr).toContain("Clean it up manually with");
  });

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
