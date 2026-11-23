import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { EngineRunnerExecutor } from "../src/agents/remote/engine-runner-executor.js";

// No real `setpriv` in CI; the executor's `wrap` seam is exercised with a
// pass-through that proves the production code *calls* it for every spawn,
// without needing real privilege-drop capabilities on the test machine.
const passthroughWrap = (bin: string, args: string[]) => ({ bin, args });

describe("EngineRunnerExecutor", () => {
  let dir: string;
  let fake: string;
  let executor: EngineRunnerExecutor | null;

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "dispatch-engine-runner-"));
    fake = path.join(dir, "fake-cli.mjs");
    writeFileSync(
      fake,
      `#!/usr/bin/env node
const mode = process.env.FAKE_ENGINE_MODE || "";
const args = process.argv.slice(2).join(" ");
if (args === "--version") {
  console.log(mode === "updated" ? "2.0.0 (Fake)" : "1.0.0 (Fake)");
  process.exit(0);
} else if (args === "auth status --json") {
  console.log(JSON.stringify({ loggedIn: true, email: "me@example.com" }));
} else if (args === "install") {
  process.exit(mode === "fail-install" ? 1 : 0);
} else if (args === "update") {
  process.exit(mode === "fail-update" ? 1 : 0);
} else {
  process.exit(2);
}
`
    );
    chmodSync(fake, 0o755);
  });

  const makeExitCode = (dir: string, code: number) => {
    const file = path.join(dir, `fake-exit-${code}.mjs`);
    writeFileSync(file, `#!/usr/bin/env node\nprocess.exit(${code});\n`);
    chmodSync(file, 0o755);
    return file;
  };

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => executor?.close());

  it("discovers an executable shared Claude only for the default managed path", async () => {
    const managed = path.join(dir, ".local", "bin", "claude");
    const custom = path.join(dir, "custom-claude");
    const shared = "/usr/local/bin/claude";
    let accessible = true;
    const install = { executable: "npm", args: [] };
    const config = {
      uid: 1000,
      gid: 1000,
      env: {
        ...process.env,
        HOME: dir,
        PATH: `/usr/local/bin:${process.env.PATH ?? ""}`,
      },
      wrap: (bin: string, args: string[]) => {
        if (accessible && bin === "/bin/sh")
          return {
            bin,
            args: args.map((arg) => (arg === shared ? fake : arg)),
          };
        return {
          bin: bin === shared && accessible ? fake : "/nonexistent",
          args,
        };
      },
    };
    executor = new EngineRunnerExecutor({
      ...config,
      engines: { claude: { bin: managed, install, update: install } },
    });
    expect(await executor.resolveBin("claude")).toBe(shared);
    expect(
      (await executor.inventory()).find((entry) => entry.id === "claude")
    ).toMatchObject({
      installed: true,
      signedIn: true,
      actions: ["login", "login_cancel"],
    });
    accessible = false;
    expect(await executor.resolveBin("claude")).toBe(managed);
    expect(
      (await executor.inventory()).find((entry) => entry.id === "claude")
    ).toMatchObject({
      installed: false,
      issue: "install-unavailable",
      detail: "Installer executable not found",
    });
    accessible = true;
    const pinned = new EngineRunnerExecutor({
      ...config,
      engines: { claude: { bin: custom, install } },
    });
    expect(await pinned.resolveBin("claude")).toBe(custom);
    expect(
      (await pinned.inventory()).find((entry) => entry.id === "claude")
        ?.installed
    ).toBe(false);
  });

  it("uses the bundled runtime for a legacy managed install with no system npm", async () => {
    const prefix = path.join(dir, ".local");
    const managed = path.join(prefix, "bin", "claude");
    const args = [
      "install",
      "--global",
      "--prefix",
      prefix,
      "@anthropic-ai/claude-code@latest",
    ];
    const packages: string[] = [];
    executor = new EngineRunnerExecutor({
      bundledRuntime: "/opt/dispatch-runner/dispatch",
      uid: 1000,
      gid: 1000,
      env: { ...process.env, HOME: dir },
      engines: {
        claude: { bin: managed, install: { executable: "npm", args } },
      },
      wrap(bin, args) {
        if (bin === "node")
          return {
            bin: "/bin/echo",
            args: [packages.length ? "v22.0.0" : "v18.0.0"],
          };
        if (bin === "/opt/dispatch-runner/dispatch") {
          if (args[0] === "--version")
            return { bin: "/bin/echo", args: ["1.3.13"] };
          expect(args.slice(0, 2)).toEqual(["add", "--global"]);
          packages.push(args.at(-1)!);
          return { bin: "/bin/sh", args: ["-c", "exit 0"] };
        }
        const installed = packages.includes("@anthropic-ai/claude-code@latest");
        return {
          bin: installed && bin === managed ? fake : "/nonexistent",
          args,
        };
      },
    });
    expect((await executor.inventory())[0]?.actions).toContain("install");
    await expect(
      executor.handle({ type: "install", engine: "claude" })
    ).resolves.toMatchObject({ ok: true });
    expect(packages).toEqual([
      `node-linux-${process.arch}@22`,
      "@anthropic-ai/claude-code@latest",
    ]);
  });

  it("reports an installed engine's version and sign-in status", async () => {
    executor = new EngineRunnerExecutor({
      uid: 1000,
      gid: 1000,
      env: process.env,
      wrap: passthroughWrap,
      engines: { claude: { bin: fake } },
    });
    const inventory = await executor.inventory();
    const claude = inventory.find((entry) => entry.id === "claude")!;
    expect(claude.installed).toBe(true);
    expect(claude.version).toBe("1.0.0");
    expect(claude.signedIn).toBe(true);
    expect(claude.detail).toBe("me@example.com");
    expect(claude.actions).toEqual(["login", "login_cancel"]);

    const codex = inventory.find((entry) => entry.id === "codex")!;
    expect(codex.installed).toBe(false);
    expect(codex.signedIn).toBeNull();
    expect(codex.actions).toEqual([]);
  });

  it("reports not installed when a configured launch path doesn't actually exist yet", async () => {
    // A fresh runner's runner.json names every engine's enforced launch
    // path before any of them have been installed — the configured path
    // string is not evidence of installation.
    executor = new EngineRunnerExecutor({
      uid: 1000,
      gid: 1000,
      env: process.env,
      wrap: passthroughWrap,
      engines: {
        claude: {
          bin: path.join(dir, "does-not-exist"),
          install: { executable: fake, args: ["install"] },
        },
      },
    });
    const inventory = await executor.inventory();
    const claude = inventory.find((entry) => entry.id === "claude")!;
    expect(claude.installed).toBe(false);
    expect(claude.version).toBeNull();
    expect(claude.signedIn).toBeNull();
    expect(claude.actions).toEqual(["install"]);
  });

  it("never reports raw CLI output as a version", async () => {
    const chatty = path.join(dir, "fake-chatty.mjs");
    writeFileSync(
      chatty,
      `#!/usr/bin/env node\nconsole.log("not a version string, just chatter");\nprocess.exit(0);\n`
    );
    chmodSync(chatty, 0o755);
    executor = new EngineRunnerExecutor({
      uid: 1000,
      gid: 1000,
      env: process.env,
      wrap: passthroughWrap,
      engines: { claude: { bin: chatty } },
    });
    const inventory = await executor.inventory();
    const claude = inventory.find((entry) => entry.id === "claude")!;
    expect(claude.installed).toBe(true);
    expect(claude.version).toBeNull();
  });

  it("flags install-unavailable and withholds the action when the installer's own executable is missing", async () => {
    executor = new EngineRunnerExecutor({
      uid: 1000,
      gid: 1000,
      env: process.env,
      wrap: passthroughWrap,
      engines: {
        codex: {
          bin: null,
          install: {
            executable: path.join(dir, "no-such-npm"),
            args: ["install", "-g"],
          },
        },
      },
    });
    const inventory = await executor.inventory();
    const codex = inventory.find((entry) => entry.id === "codex")!;
    expect(codex.installed).toBe(false);
    expect(codex.actions).toEqual([]);
    expect(codex.issue).toBe("install-unavailable");
  });

  it("pushes a fresh inventory snapshot for a status operation", async () => {
    executor = new EngineRunnerExecutor({
      uid: 1000,
      gid: 1000,
      env: process.env,
      wrap: passthroughWrap,
      engines: { claude: { bin: fake } },
    });
    const events: unknown[] = [];
    const ack = await executor.handle({ type: "status" }, (event) =>
      events.push(event)
    );
    expect(ack).toEqual({ ok: true });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "inventory",
      entries: expect.arrayContaining([
        expect.objectContaining({ id: "claude", installed: true }),
      ]),
    });
  });

  it("offers install only when a managed install command is configured", async () => {
    executor = new EngineRunnerExecutor({
      uid: 1000,
      gid: 1000,
      env: process.env,
      wrap: passthroughWrap,
      engines: {
        codex: { bin: null, install: { executable: fake, args: ["install"] } },
      },
    });
    const inventory = await executor.inventory();
    expect(inventory.find((entry) => entry.id === "codex")?.actions).toEqual([
      "install",
    ]);
  });

  it("runs a configured update and verifies the version advanced", async () => {
    executor = new EngineRunnerExecutor({
      uid: 1000,
      gid: 1000,
      env: { ...process.env, FAKE_ENGINE_MODE: "updated" },
      wrap: passthroughWrap,
      engines: {
        claude: { bin: fake, update: { executable: fake, args: ["update"] } },
      },
    });
    const events: string[] = [];
    const ack = await executor.handle(
      { type: "update", engine: "claude" },
      (event) => events.push(event.type)
    );
    expect(ack.ok).toBe(true);
    expect(events).toContain("operation_progress");
    expect(events[events.length - 1]).toBe("operation_complete");
  });

  it("reports a failed update as ok:false with the exit code, not a false success", async () => {
    executor = new EngineRunnerExecutor({
      uid: 1000,
      gid: 1000,
      env: { ...process.env, FAKE_ENGINE_MODE: "fail-update" },
      wrap: passthroughWrap,
      engines: {
        claude: { bin: fake, update: { executable: fake, args: ["update"] } },
      },
    });
    const events: unknown[] = [];
    const ack = await executor.handle(
      { type: "update", engine: "claude" },
      (event) => events.push(event)
    );
    expect(ack).toMatchObject({
      ok: false,
      error: expect.stringContaining("exit code 1"),
    });
    expect(events.at(-1)).toMatchObject({
      type: "operation_complete",
      success: false,
    });
  });

  it("reports an already-current update as success, not a failure", async () => {
    // The fake CLI's update command exits 0 and leaves the version
    // unchanged (no FAKE_ENGINE_MODE override) — a legitimate no-op.
    executor = new EngineRunnerExecutor({
      uid: 1000,
      gid: 1000,
      env: process.env,
      wrap: passthroughWrap,
      engines: {
        claude: { bin: fake, update: { executable: fake, args: ["update"] } },
      },
    });
    const ack = await executor.handle({ type: "update", engine: "claude" });
    expect(ack).toMatchObject({
      ok: true,
      message: expect.stringContaining("up to date"),
    });
  });

  it("treats a setpriv-started but command-not-found installer as unusable (exit 127)", async () => {
    const exit127 = makeExitCode(dir, 127);
    executor = new EngineRunnerExecutor({
      uid: 1000,
      gid: 1000,
      env: process.env,
      wrap: passthroughWrap,
      engines: {
        codex: { bin: null, install: { executable: exit127, args: [] } },
      },
    });
    const inventory = await executor.inventory();
    const codex = inventory.find((entry) => entry.id === "codex")!;
    expect(codex.actions).toEqual([]);
    expect(codex.issue).toBe("install-unavailable");
  });

  it("stages a Codex device sign-in under the workload's own home, never the supervisor's", async () => {
    const workloadHome = mkdtempSync(
      path.join(os.tmpdir(), "dispatch-workload-home-")
    );
    const codexFake = path.join(dir, "fake-codex.mjs");
    writeFileSync(
      codexFake,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2).join(" ");
if (args === "login --device-auth") {
  process.stdout.write("Open: https://auth.openai.com/codex/device\\nEnter code: ABCD-1234\\n");
  setTimeout(() => {
    writeFileSync(process.env.CODEX_HOME + "/auth.json", "{}");
    process.exit(0);
  }, 30);
} else if (args === "login status") {
  console.log("Logged in using ChatGPT");
} else {
  process.exit(2);
}
`
    );
    chmodSync(codexFake, 0o755);
    // Chowning the stage dir to the process's own uid/gid is always
    // permitted (no root needed), so this exercises the real
    // createStageDir/chown code path rather than a mocked seam.
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    // vitest.config.ts pins CODEX_HOME for the whole suite so no test
    // ever touches the real ~/.codex; a real runner's env never sets it,
    // so this test must clear it to exercise the actual $HOME/.codex
    // fallback the staged login script falls back to.
    const { CODEX_HOME: _pinned, ...envWithoutCodexHome } = process.env;
    executor = new EngineRunnerExecutor({
      uid,
      gid,
      env: { ...envWithoutCodexHome, HOME: workloadHome },
      wrap: passthroughWrap,
      engines: { codex: { bin: codexFake } },
    });
    const started = await executor.handle({
      type: "login_start",
      engine: "codex",
    });
    expect(started.ok).toBe(true);
    expect(started.login?.status).toBe("waiting");
    expect(started.login?.userCode).toBe("ABCD-1234");

    const untilTerminal = async (loginId: string, timeoutMs = 5_000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const status = await executor!.handle({
          type: "login_status",
          loginId,
        });
        if (
          status.login?.status === "succeeded" ||
          status.login?.status === "failed"
        )
          return status;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("timed out waiting for the sign-in to settle");
    };
    const status = await untilTerminal(started.login!.id);
    expect(status.ok).toBe(true);
    expect(status.login?.status).toBe("succeeded");
    // The final credential landed under the workload home we configured
    // — proof the staged script's $HOME-derived path actually resolved
    // to it, not to this (real) process's own home. This machine's real
    // ~/.codex may already contain unrelated files from ordinary local
    // use, so the isolation proof is "it wrote here", not "it didn't
    // write there" against that uncontrolled real directory.
    expect(existsSync(path.join(workloadHome, ".codex", "auth.json"))).toBe(
      true
    );
    rmSync(workloadHome, { recursive: true, force: true });
  });

  it("rejects an operation with no configured managed command", async () => {
    executor = new EngineRunnerExecutor({
      uid: 1000,
      gid: 1000,
      env: process.env,
      wrap: passthroughWrap,
      engines: { claude: { bin: fake } },
    });
    const ack = await executor.handle({ type: "update", engine: "claude" });
    expect(ack).toMatchObject({ ok: false });
  });

  it("runs sign-in through the same EngineLogins flow, wrapped", async () => {
    const loginFake = path.join(dir, "fake-login.mjs");
    writeFileSync(
      loginFake,
      `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args === "auth login") {
  process.stdout.write("Visit: https://claude.com/cai/oauth/authorize?code=1\\nPaste code here if prompted > ");
  process.stdin.once("data", (chunk) => {
    process.exit(chunk.toString().trim() === "good" ? 0 : 1);
  });
} else if (args === "auth status --json") {
  console.log(JSON.stringify({ loggedIn: true, email: "me@example.com" }));
} else {
  process.exit(2);
}
`
    );
    chmodSync(loginFake, 0o755);
    executor = new EngineRunnerExecutor({
      uid: 1000,
      gid: 1000,
      env: process.env,
      wrap: passthroughWrap,
      engines: { claude: { bin: loginFake } },
    });
    const started = await executor.handle({
      type: "login_start",
      engine: "claude",
    });
    expect(started.ok).toBe(true);
    expect(started.login?.status).toBe("waiting");
    expect(started.login?.url).toContain("https://claude.com");
    const submitted = await executor.handle({
      type: "login_submit",
      loginId: started.login!.id,
      code: "good",
    });
    expect(submitted.ok).toBe(true);
  });

  it("runs every sign-in process as the workload account", async () => {
    // A fixture CLI behind the workload wrap: the wrap stands in for the
    // setpriv drop and records each process it starts.
    const workloadHome = mkdtempSync(
      path.join(os.tmpdir(), "dispatch-workload-home-")
    );
    const loginFake = path.join(dir, "fake-workload-login.mjs");
    writeFileSync(
      loginFake,
      `#!/usr/bin/env node
const args = process.argv.slice(2).join(" ");
if (args === "--version") console.log("2.0.0");
else if (args === "auth status --json") console.log(JSON.stringify({ loggedIn: process.env.HOME === ${JSON.stringify(workloadHome)}, email: "workload@example.com" }));
else if (args === "auth login") {
  console.log("Visit: https://claude.com/cai/oauth/authorize?state=x");
  process.stdin.once("data", () => process.exit(0));
} else process.exit(2);
`
    );
    chmodSync(loginFake, 0o755);
    const wrapped: string[][] = [];
    executor = new EngineRunnerExecutor({
      uid: 1234,
      gid: 5678,
      env: { PATH: process.env.PATH, HOME: workloadHome },
      wrap: (bin, args) => {
        wrapped.push([bin, ...args]);
        return { bin, args };
      },
      engines: { claude: { bin: loginFake } },
    });
    const started = await executor.handle({
      type: "login_start",
      engine: "claude",
    });
    expect(started.login?.status).toBe("waiting");
    await executor.handle({
      type: "login_submit",
      loginId: started.login!.id,
      code: "good",
    });
    await expect
      .poll(
        async () =>
          (
            await executor!.handle({
              type: "login_status",
              loginId: started.login!.id,
            })
          ).login?.status
      )
      .toBe("succeeded");
    const done = await executor.handle({
      type: "login_status",
      loginId: started.login!.id,
    });
    // Signed in as the workload: the status check ran with its HOME.
    expect(done.login?.detail).toBe("workload@example.com");
    // The login itself and its status check both went through the wrap.
    expect(
      wrapped.some((argv) => argv[0] === "/bin/sh" && argv.includes("login"))
    ).toBe(true);
    expect(
      wrapped.some(
        (argv) =>
          argv[0] === "/bin/sh" &&
          argv.slice(-3).join(" ") === "auth status --json"
      )
    ).toBe(true);
    rmSync(workloadHome, { recursive: true, force: true });
  });

  it("refuses sign-in for an engine with no login flow", async () => {
    executor = new EngineRunnerExecutor({
      uid: 1000,
      gid: 1000,
      env: process.env,
      wrap: passthroughWrap,
      engines: { opencode: { bin: fake } },
    });
    const ack = await executor.handle({
      type: "login_start",
      engine: "opencode",
    });
    expect(ack).toMatchObject({ ok: false });
  });
});
