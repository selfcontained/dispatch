import { mkdtemp, readFile, rm, writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/shared/lib/run-command.js", () => ({
  runCommand: vi.fn(),
}));

const { createTmuxRuntime } = await import("../src/agents/tmux/runtime.js");
const { runCommand } = await import("../src/shared/lib/run-command.js");

const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stdout = "") => ({ exitCode: 1, stdout, stderr: "" });

const noopLogger = (() => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: "silent",
    child: () => logger,
  };
  return logger as unknown as import("fastify").FastifyBaseLogger;
})();

beforeEach(() => {
  vi.mocked(runCommand).mockReset();
});

const matchArgs = (args: string[], pattern: string[]) =>
  pattern.every((p, i) => args[i] === p);

describe("TmuxRuntime — capabilities", () => {
  it("tracksSessions() returns true (tmux backs sessions with real OS state)", () => {
    const runtime = createTmuxRuntime(noopLogger);
    expect(runtime.tracksSessions()).toBe(true);
  });
});

describe("TmuxRuntime — hasSession", () => {
  it("returns true when `tmux has-session` exits 0", async () => {
    vi.mocked(runCommand).mockResolvedValue(ok());
    const runtime = createTmuxRuntime(noopLogger);
    expect(await runtime.hasSession("dispatch_agt_x")).toBe(true);
    expect(vi.mocked(runCommand).mock.calls[0]?.[1]).toEqual([
      "has-session",
      "-t",
      "dispatch_agt_x",
    ]);
  });

  it("returns false when `tmux has-session` exits non-zero", async () => {
    vi.mocked(runCommand).mockResolvedValue(fail());
    const runtime = createTmuxRuntime(noopLogger);
    expect(await runtime.hasSession("dispatch_agt_x")).toBe(false);
  });
});

describe("TmuxRuntime — ensureNoExistingSession", () => {
  it("kills the session if it exists", async () => {
    vi.mocked(runCommand).mockImplementation(async (_cmd, args) => {
      if (args[0] === "has-session") return ok(); // exists
      return ok(); // kill-session
    });
    const runtime = createTmuxRuntime(noopLogger);
    await runtime.ensureNoExistingSession("dispatch_agt_x");

    const killCall = vi
      .mocked(runCommand)
      .mock.calls.find(([, a]) => a[0] === "kill-session");
    expect(killCall).toBeDefined();
  });

  it("is a no-op if the session does not exist", async () => {
    vi.mocked(runCommand).mockImplementation(async (_cmd, args) => {
      if (args[0] === "has-session") return fail();
      return ok();
    });
    const runtime = createTmuxRuntime(noopLogger);
    await runtime.ensureNoExistingSession("dispatch_agt_x");

    const killCall = vi
      .mocked(runCommand)
      .mock.calls.find(([, a]) => a[0] === "kill-session");
    expect(killCall).toBeUndefined();
  });
});

describe("TmuxRuntime — stopSession", () => {
  it("force=true skips the C-c grace period and goes straight to kill", async () => {
    vi.mocked(runCommand).mockImplementation(async (_cmd, args) => {
      if (args[0] === "has-session") return ok();
      return ok();
    });
    const runtime = createTmuxRuntime(noopLogger);
    await runtime.stopSession("dispatch_agt_x", true);

    const sendKeysCall = vi
      .mocked(runCommand)
      .mock.calls.find(([, a]) => a[0] === "send-keys");
    expect(sendKeysCall).toBeUndefined();
    const killCall = vi
      .mocked(runCommand)
      .mock.calls.find(([, a]) => a[0] === "kill-session");
    expect(killCall).toBeDefined();
  });

  it("force=false sends Ctrl-C, waits, and then kills if the session is still alive", async () => {
    vi.mocked(runCommand).mockImplementation(async (_cmd, args) => {
      if (args[0] === "has-session") return ok(); // still alive after C-c
      return ok();
    });
    const runtime = createTmuxRuntime(noopLogger);

    const t0 = Date.now();
    await runtime.stopSession("dispatch_agt_x", false);
    const elapsed = Date.now() - t0;

    // Grace is 1200ms — verify the wait actually happened.
    expect(elapsed).toBeGreaterThanOrEqual(1100);

    const sendKeysCall = vi
      .mocked(runCommand)
      .mock.calls.find(([, a]) => a[0] === "send-keys");
    expect(sendKeysCall).toBeDefined();
    expect(sendKeysCall?.[1]).toContain("C-c");

    const killCall = vi
      .mocked(runCommand)
      .mock.calls.find(([, a]) => a[0] === "kill-session");
    expect(killCall).toBeDefined();
  }, 5000);

  it("force=false skips the kill when C-c made the session exit on its own", async () => {
    vi.mocked(runCommand).mockImplementation(async (_cmd, args) => {
      if (args[0] === "has-session") return fail(); // already gone
      return ok();
    });
    const runtime = createTmuxRuntime(noopLogger);
    await runtime.stopSession("dispatch_agt_x", false);

    const killCall = vi
      .mocked(runCommand)
      .mock.calls.find(([, a]) => a[0] === "kill-session");
    expect(killCall).toBeUndefined();
  }, 5000);
});

describe("TmuxRuntime — listSessions", () => {
  it("parses tmux list-sessions output and filters by prefix", async () => {
    vi.mocked(runCommand).mockResolvedValue(
      ok(
        [
          "dispatch_agt_aaa:1700000000",
          "dispatch_agt_bbb:1700000100",
          "other-session:1700000200",
          "dispatch_dev_agt_ccc:1700000300",
        ].join("\n")
      )
    );
    const runtime = createTmuxRuntime(noopLogger);
    const result = await runtime.listSessions("dispatch_agt_");

    expect(result).toEqual([
      { name: "dispatch_agt_aaa", createdAt: 1700000000 },
      { name: "dispatch_agt_bbb", createdAt: 1700000100 },
    ]);
  });

  it("returns empty when tmux is not running (runCommand throws)", async () => {
    vi.mocked(runCommand).mockRejectedValue(
      new Error("tmux: command not found")
    );
    const runtime = createTmuxRuntime(noopLogger);
    expect(await runtime.listSessions("dispatch_agt_")).toEqual([]);
  });

  it("returns empty when stdout is blank (no sessions)", async () => {
    vi.mocked(runCommand).mockResolvedValue(ok(""));
    const runtime = createTmuxRuntime(noopLogger);
    expect(await runtime.listSessions("dispatch_agt_")).toEqual([]);
  });
});

describe("TmuxRuntime — killSession", () => {
  it("swallows errors from kill-session (best-effort)", async () => {
    vi.mocked(runCommand).mockRejectedValue(new Error("no such session"));
    const runtime = createTmuxRuntime(noopLogger);
    await expect(
      runtime.killSession("dispatch_agt_gone")
    ).resolves.toBeUndefined();
  });
});

describe("TmuxRuntime — getCurrentCwd", () => {
  // The cwd resolver has a TTL cache that's important to verify — it's
  // the only state the runtime closure holds and a regression here
  // shows up as a hot ps/lsof loop on every reconcile tick.

  it("returns null when sessionName is empty/whitespace (no fallback baked in)", async () => {
    const runtime = createTmuxRuntime(noopLogger);
    expect(
      await runtime.getCurrentCwd({
        sessionName: "  ",
        agentId: "agt_x",
      })
    ).toBeNull();
    // No tmux invocation required.
    expect(vi.mocked(runCommand)).not.toHaveBeenCalled();
  });

  it("falls back to pane_current_path when no agent CLI is found among children", async () => {
    vi.mocked(runCommand).mockImplementation(async (_cmd, args) => {
      if (matchArgs(args, ["display-message", "-p", "-t"])) {
        if (args.includes("#{pane_pid}")) return ok("12345");
        if (args.includes("#{pane_current_path}")) return ok("/the/cwd");
      }
      if (args[0] === "-P" /* pgrep */) return ok(""); // no children
      return fail();
    });
    const runtime = createTmuxRuntime(noopLogger);
    expect(
      await runtime.getCurrentCwd({
        sessionName: "dispatch_agt_x",
        agentId: "agt_x",
      })
    ).toBe("/the/cwd");
  });

  it("returns null when both pid-walk and pane_current_path fail (manager applies fallback)", async () => {
    vi.mocked(runCommand).mockImplementation(async () => fail());
    const runtime = createTmuxRuntime(noopLogger);
    expect(
      await runtime.getCurrentCwd({
        sessionName: "dispatch_agt_x",
        agentId: "agt_x",
      })
    ).toBeNull();
  });

  it("caches a successful resolution for the configured TTL", async () => {
    let pathReadCount = 0;
    vi.mocked(runCommand).mockImplementation(async (_cmd, args) => {
      if (matchArgs(args, ["display-message", "-p", "-t"])) {
        if (args.includes("#{pane_pid}")) return ok("12345");
        if (args.includes("#{pane_current_path}")) {
          pathReadCount += 1;
          return ok("/cached/cwd");
        }
      }
      if (args[0] === "-P") return ok("");
      return fail();
    });

    const runtime = createTmuxRuntime(noopLogger);

    const a = await runtime.getCurrentCwd({
      sessionName: "dispatch_agt_x",
      agentId: "agt_x",
    });
    const b = await runtime.getCurrentCwd({
      sessionName: "dispatch_agt_x",
      agentId: "agt_x",
    });

    expect(a).toBe("/cached/cwd");
    expect(b).toBe("/cached/cwd");
    // Second call should have hit the cache, not re-invoked
    // pane_current_path.
    expect(pathReadCount).toBe(1);
  });

  it("isolates cache entries by (agentId, sessionName) — different agents don't share a cache slot", async () => {
    vi.mocked(runCommand).mockImplementation(async (_cmd, args) => {
      if (matchArgs(args, ["display-message", "-p", "-t"])) {
        if (args.includes("#{pane_pid}")) return ok("123");
        if (args.includes("#{pane_current_path}")) {
          // Use the session arg to differentiate.
          if (args.includes("session-A")) return ok("/cwd-A");
          if (args.includes("session-B")) return ok("/cwd-B");
        }
      }
      if (args[0] === "-P") return ok("");
      return fail();
    });

    const runtime = createTmuxRuntime(noopLogger);
    const a = await runtime.getCurrentCwd({
      sessionName: "session-A",
      agentId: "agt_a",
    });
    const b = await runtime.getCurrentCwd({
      sessionName: "session-B",
      agentId: "agt_b",
    });
    expect(a).toBe("/cwd-A");
    expect(b).toBe("/cwd-B");
  });
});

describe("TmuxRuntime — readExitInfo", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "runtime-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when the exit file does not exist", async () => {
    const runtime = createTmuxRuntime(noopLogger);
    expect(
      await runtime.readExitInfo("dispatch_agt_doesnotexist_xyz")
    ).toBeNull();
  });

  it("parses `EXIT:N` from /tmp/dispatch_<session>.exit", async () => {
    const sessionName = `dispatch_agt_test_${Date.now()}`;
    const exitFile = `/tmp/dispatch_${sessionName}.exit`;
    try {
      await writeFile(exitFile, "EXIT:42\n");
      const runtime = createTmuxRuntime(noopLogger);
      expect(await runtime.readExitInfo(sessionName)).toBe(42);
    } finally {
      await unlink(exitFile).catch(() => {});
    }
  });

  it("returns null when the file content is malformed", async () => {
    const sessionName = `dispatch_agt_malformed_${Date.now()}`;
    const exitFile = `/tmp/dispatch_${sessionName}.exit`;
    try {
      await writeFile(exitFile, "garbage content\n");
      const runtime = createTmuxRuntime(noopLogger);
      expect(await runtime.readExitInfo(sessionName)).toBeNull();
    } finally {
      await unlink(exitFile).catch(() => {});
    }
  });
});

describe("TmuxRuntime — readSetupLogTail", () => {
  it("returns empty when the log file does not exist", async () => {
    const runtime = createTmuxRuntime(noopLogger);
    expect(await runtime.readSetupLogTail("doesnotexist_xyz_qrs")).toBe("");
  });

  it("formats the last 20 lines with a 'Setup log' header", async () => {
    const id = `setup_test_${Date.now()}`;
    const logFile = `/tmp/dispatch_setup_${id}.log`;
    try {
      const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
      await writeFile(logFile, lines.join("\n"));

      const runtime = createTmuxRuntime(noopLogger);
      const tail = await runtime.readSetupLogTail(id);

      expect(tail.startsWith("\n\nSetup log (last 20 lines):\n")).toBe(true);
      // Last 20 lines should be 6..25
      expect(tail).toContain("line 6");
      expect(tail).toContain("line 25");
      expect(tail).not.toContain("line 5");
    } finally {
      await unlink(logFile).catch(() => {});
    }
  });
});

describe("TmuxRuntime — launch (setup-script payload)", () => {
  // The runtime owns where setup scripts live on disk — the manager
  // doesn't pass a path. The test cleans up the runtime's chosen path.

  afterEach(async () => {
    await unlink("/tmp/dispatch_setup_agt_xyz_runtime_test.sh").catch(() => {});
  });

  it("writes the setup script to a runtime-chosen path and runs `bash <path>` inside the wrapped launch", async () => {
    vi.mocked(runCommand).mockImplementation(async (_cmd, args) => {
      if (args[0] === "has-session") return ok(); // post-launch verify
      return ok();
    });

    const runtime = createTmuxRuntime(noopLogger);
    await runtime.launch({
      sessionName: "dispatch_agt_xyz_runtime_test",
      cwd: "/projects/foo",
      agentId: "agt_xyz_runtime_test",
      payload: {
        kind: "setup-script",
        scriptContent: "#!/usr/bin/env bash\necho hello\n",
      },
    });

    // Script is on disk at the runtime's chosen path
    // (`/tmp/dispatch_setup_<agentId>.sh`).
    const expectedScriptPath = "/tmp/dispatch_setup_agt_xyz_runtime_test.sh";
    const written = await readFile(expectedScriptPath, "utf-8");
    expect(written).toBe("#!/usr/bin/env bash\necho hello\n");

    // tmux new-session ran with the wrapped `bash <path>` as the command
    const newSessionCall = vi
      .mocked(runCommand)
      .mock.calls.find(([, a]) => a.includes("new-session"));
    expect(newSessionCall?.[1]).toContain("dispatch_agt_xyz_runtime_test");
    expect(newSessionCall?.[1]).toContain("/projects/foo");
    const wrappedCommand = newSessionCall?.[1]?.[
      newSessionCall[1].length - 1
    ] as string;
    // The same outer wrap that agent-command gets — stderr tee + exit
    // capture — applies to setup-script too. The script no longer needs
    // to do its own stderr / exit handling.
    expect(wrappedCommand).toContain(
      `tee "/tmp/dispatch_setup_agt_xyz_runtime_test.log"`
    );
    expect(wrappedCommand).toContain(`bash ${expectedScriptPath}`);
    expect(wrappedCommand).toContain(
      `echo "EXIT:$?" > /tmp/dispatch_dispatch_agt_xyz_runtime_test.exit`
    );
  });

  it("throws if the post-launch has-session check fails (fast-fail detection)", async () => {
    vi.mocked(runCommand).mockImplementation(async (_cmd, args) => {
      if (args[0] === "has-session") return fail(); // session died
      return ok();
    });

    const runtime = createTmuxRuntime(noopLogger);
    await expect(
      runtime.launch({
        sessionName: "dispatch_agt_x",
        cwd: "/projects/foo",
        agentId: "agt_xyz_runtime_test",
        payload: {
          kind: "setup-script",
          scriptContent: "#!/usr/bin/env bash\nexit 1\n",
        },
      })
    ).rejects.toThrow(/tmux session exited immediately after launch/);
  });
});

describe("TmuxRuntime — launch (agent-command payload)", () => {
  it("wraps the inline command with stderr-tee and exit-code capture (paths runtime-internal)", async () => {
    vi.mocked(runCommand).mockImplementation(async (_cmd, args) => {
      if (args[0] === "has-session") return ok();
      return ok();
    });

    const runtime = createTmuxRuntime(noopLogger);
    await runtime.launch({
      sessionName: "dispatch_agt_y",
      cwd: "/projects/bar",
      agentId: "agt_y",
      payload: { kind: "agent-command", command: "/opt/claude --foo" },
    });

    const newSessionCall = vi
      .mocked(runCommand)
      .mock.calls.find(([, a]) => a.includes("new-session"));
    const wrappedCommand = newSessionCall?.[1]?.[
      newSessionCall[1].length - 1
    ] as string;

    // The wrapper bakes in: stderr tee to the agent's setup log file
    // (path derived from agentId), the agent command itself, and
    // EXIT:$? to the per-session exit file (path derived from
    // sessionName). The manager doesn't supply or know either path.
    expect(wrappedCommand).toContain(`tee "/tmp/dispatch_setup_agt_y.log"`);
    expect(wrappedCommand).toContain("/opt/claude --foo");
    expect(wrappedCommand).toContain(
      `echo "EXIT:$?" > /tmp/dispatch_dispatch_agt_y.exit`
    );
  });

  it("escapes embedded single quotes in the command (security regression check)", async () => {
    // The wrapper interpolates the command into a single-quoted bash
    // string. An attacker-controlled value with `'` in it must not
    // break out of the wrapping.
    vi.mocked(runCommand).mockImplementation(async (_cmd, args) => {
      if (args[0] === "has-session") return ok();
      return ok();
    });

    const runtime = createTmuxRuntime(noopLogger);
    await runtime.launch({
      sessionName: "dispatch_agt_z",
      cwd: "/tmp",
      agentId: "agt_z",
      payload: {
        kind: "agent-command",
        command: `echo 'inner-quote'`,
      },
    });

    const newSessionCall = vi
      .mocked(runCommand)
      .mock.calls.find(([, a]) => a.includes("new-session"));
    const wrappedCommand = newSessionCall?.[1]?.[
      newSessionCall[1].length - 1
    ] as string;
    // The classic '\'' escape must appear in place of the embedded `'`.
    expect(wrappedCommand).toContain(`echo '\\''inner-quote'\\''`);
  });
});
