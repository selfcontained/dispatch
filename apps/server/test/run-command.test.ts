import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCommand } from "../src/shared/lib/run-command.js";
import { runCommand as runWorkloadCommand } from "../../../packages/runner/src/workload/shared/lib/run-command.js";

describe.each([
  ["server", runCommand],
  ["runner", runWorkloadCommand],
])("%s runCommand", (_name, runCommand) => {
  it("captures stdout from a successful command", async () => {
    const result = await runCommand("echo", ["hello"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
  });

  it("captures stderr", async () => {
    const result = await runCommand("sh", ["-c", "echo err >&2 && exit 0"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("err");
  });

  it("rejects on non-zero exit code by default", async () => {
    await expect(runCommand("sh", ["-c", "exit 1"])).rejects.toThrow(
      "exitCode=1"
    );
  });

  it("allows specific exit codes via allowedExitCodes", async () => {
    const result = await runCommand("sh", ["-c", "exit 42"], {
      allowedExitCodes: [0, 42],
    });
    expect(result.exitCode).toBe(42);
  });

  it("rejects on disallowed exit code even when allowedExitCodes is set", async () => {
    await expect(
      runCommand("sh", ["-c", "exit 2"], { allowedExitCodes: [0, 1] })
    ).rejects.toThrow("exitCode=2");
  });

  it("respects cwd option", async () => {
    const result = await runCommand("pwd", [], { cwd: "/tmp" });
    expect(result.stdout).toContain("/tmp");
  });

  it("passes environment variables", async () => {
    const result = await runCommand("sh", ["-c", "echo $TEST_VAR"], {
      env: { TEST_VAR: "dispatch-test" },
    });
    expect(result.stdout).toBe("dispatch-test");
  });

  it("rejects when the command does not exist", async () => {
    await expect(
      runCommand("this-command-should-not-exist-9f8a7b", [])
    ).rejects.toThrow();
  });

  it("rejects on timeout", async () => {
    await expect(
      runCommand("sleep", ["10"], { timeoutMs: 100 })
    ).rejects.toThrow("timed out");
  });

  it("trims stdout and stderr whitespace", async () => {
    const result = await runCommand("sh", ["-c", "echo '  padded  '"]);
    expect(result.stdout).toBe("padded");
  });

  it("handles commands with multiple arguments", async () => {
    const result = await runCommand("echo", ["one", "two", "three"]);
    expect(result.stdout).toBe("one two three");
  });

  it("handles empty stdout", async () => {
    const result = await runCommand("true", []);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});

it("keeps exit details and the stderr tail for runner commands", async () => {
  await expect(
    runWorkloadCommand("sh", ["-c", "printf 'install denied' >&2; exit 42"])
  ).rejects.toMatchObject({
    timedOut: false,
    exitCode: 42,
    stderrTail: "install denied",
  });
  await expect(
    runWorkloadCommand(
      "sh",
      ["-c", "printf 'still installing' >&2; exec sleep 10"],
      {
        timeoutMs: 100,
      }
    )
  ).rejects.toMatchObject({
    timedOut: true,
    timeoutMs: 100,
    stderrTail: "still installing",
  });
});

it("drains both output sockets, kills timed-out children and records failures in a compiled runner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "compiled-command-"));
  const binary = path.join(root, "command");
  const fixture = fileURLToPath(
    new URL("./fixtures/run-command.ts", import.meta.url)
  );
  try {
    await runCommand(
      "bun",
      ["build", "--compile", fixture, "--outfile", binary],
      {
        timeoutMs: 30_000,
      }
    );
    const run = async (mode: string) =>
      JSON.parse(
        (
          await runCommand(binary, [process.execPath, mode], {
            timeoutMs: 15_000,
          })
        ).stdout
      );
    expect(await run("output")).toEqual({
      exitCode: 0,
      stdoutLength: 16 * 1024 * 1024,
      stderrLength: 16 * 1024 * 1024,
    });
    expect(await run("exit")).toMatchObject({
      exitCode: 42,
      timedOut: false,
      stderrTail: "x".repeat(8192),
    });
    expect(await run("timeout")).toMatchObject({
      timedOut: true,
      timeoutMs: 500,
      stderrTail: "install pending",
    });
    expect(await run("missing")).toMatchObject({ code: "ENOENT" });
    const killed = await run("kill");
    expect(killed).toMatchObject({ timedOut: true, timeoutMs: 500 });
    const pid = Number(killed.stderrTail);
    expect(pid).toBeGreaterThan(0);
    await expect
      .poll(
        () => {
          try {
            process.kill(pid, 0);
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            return false;
          }
        },
        { timeout: 2_000 }
      )
      .toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
