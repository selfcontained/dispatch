import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
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
  process.exit(0);
} else {
  process.exit(2);
}
`
    );
    chmodSync(fake, 0o755);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => executor?.close());

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
