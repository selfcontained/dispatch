import { describe, expect, it } from "vitest";

import { runCommand } from "../src/shared/lib/run-command.js";

describe("runCommand", () => {
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
