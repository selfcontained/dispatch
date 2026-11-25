import {
  mkdtemp,
  writeFile,
  mkdir,
  readFile,
  rm,
  symlink,
  realpath,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  EngineUpdateOperations,
  engineUpdatePort,
  type EngineOperationStore,
} from "./helpers/native-engine-updates.js";
import type { EngineCalls } from "../src/runners/local.js";
import { EngineRunnerExecutor } from "../src/agents/remote/engine-runner-executor.js";

describe("persistent workload engine port", () => {
  it("relays the request-id safety alarm to the supervisor log without forwarding private stderr", async () => {
    const home = await mkdtemp(
      path.join(os.tmpdir(), "dispatch-engine-alarm-")
    );
    const worker = path.join(home, "worker.mjs");
    await writeFile(
      worker,
      `
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id } = JSON.parse(line);
  console.error('fixture private diagnostics');
  console.log(JSON.stringify({ id, error: { code: 'busy', message: 'Engine update host request-id safety ceiling reached.' } }));
});
`
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const executor = new EngineRunnerExecutor({
      uid: 1000,
      gid: 1000,
      env: { HOME: home, PATH: process.env.PATH },
      engines: {},
      hostCommand: [process.execPath, worker],
      wrap: (bin, args) => ({ bin, args }),
    });
    try {
      for (let i = 0; i < 2; i++) {
        await expect(
          executor.callHost("engine.update.spawn", {
            requestId: String(i),
            command: { executable: "fixture", args: [] },
            timeoutMs: 1000,
          })
        ).rejects.toMatchObject({ code: "busy" });
      }
      expect(log).toHaveBeenCalledExactlyOnceWith(
        "Engine update host request-id safety ceiling reached; no request ids were evicted."
      );
    } finally {
      executor.close();
      log.mockRestore();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("retains plugin failure details and cache across request connections", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dispatch-engine-host-"));
    const bin = path.join(home, "fixture-cli");
    const log = path.join(home, "calls");
    await writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2).join(' ');
fs.appendFileSync(${JSON.stringify(log)}, args + '\\n');
if (args === '--version') console.log('codex-cli 1.0.0');
else { console.error('fixture raw probe failure'); process.exitCode = 1; }
`,
      { mode: 0o755 }
    );
    const wrapped: string[] = [];
    const executor = new EngineRunnerExecutor({
      uid: 1000,
      gid: 1000,
      env: {
        HOME: home,
        PATH: process.env.PATH,
        CODEX_HOME: path.join(home, "codex"),
        CLAUDE_CONFIG_DIR: path.join(home, "claude"),
        SHELL: "/bin/sh",
      },
      engines: {
        codex: { bin },
        claude: { bin: path.join(home, "missing-claude") },
        opencode: { bin: path.join(home, "missing-opencode") },
      },
      hostCommand: [
        "bun",
        fileURLToPath(new URL("../src/main.ts", import.meta.url)),
        "runner-engine-host",
      ],
      wrap: (bin, args) => {
        wrapped.push(bin);
        return { bin, args };
      },
    });
    try {
      const request = { engine: "codex", plugin: "dispatch@dispatch" };
      const first = await executor.callHost("engine.plugin.status", request);
      expect(first).toMatchObject({
        agentType: "codex",
        installed: false,
        updateAvailable: false,
        actions: ["install"],
      });
      expect(first.detectionError).toBeTruthy();
      expect(first.detectionError).not.toContain("fixture raw probe failure");
      expect(await executor.callHost("engine.plugin.status", request)).toEqual(
        first
      );
      expect(
        (await readFile(log, "utf8")).match(/plugin list --json/g)
      ).toHaveLength(1);
      await executor.callHost("engine.plugin.status", {
        ...request,
        refresh: true,
      });
      expect(
        (await readFile(log, "utf8")).match(/plugin list --json/g)
      ).toHaveLength(2);
      const failure = await executor.callHost("engine.plugin.apply", {
        ...request,
        action: "update",
        requestId: "fixture-plugin-update",
      });
      expect(failure.error).toBe("Failed to refresh the dispatch marketplace.");
      expect(failure.ranCommands).toEqual([
        "plugin marketplace upgrade dispatch --json",
      ]);
      expect(failure.probeFailed).toBe(true);
      expect(failure.detectionError).toEqual(first.detectionError);
      expect(wrapped).toContain("bun");
    } finally {
      executor.close();
      await rm(home, { recursive: true, force: true });
    }
  });
  it("detects and updates only a fixture npm installation without configured commands", async () => {
    const home = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "dispatch-engine-detected-"))
    );
    const prefix = path.join(home, "prefix");
    const version = path.join(home, "version");
    const file = async (name: string, content: string) => {
      const target = path.join(prefix, name);
      // Main rejects group-writable package prefixes. Keep this fixture
      // user-owned independently of the test host's umask.
      await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      await writeFile(target, content, { mode: 0o755 });
      return target;
    };
    await writeFile(version, "1.0.0");
    const real = await file(
      "lib/node_modules/@openai/codex/bin/codex.js",
      `#!/usr/bin/env node
console.log('codex-cli '+require('node:fs').readFileSync(${JSON.stringify(version)},'utf8'));
`
    );
    await file(
      "lib/node_modules/@openai/codex/package.json",
      JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } })
    );
    const npm = await file(
      "lib/node_modules/npm/bin/npm-cli.js",
      `require('node:fs').writeFileSync(${JSON.stringify(version)},'2.0.0'); console.log('fixture npm updated');`
    );
    await file(
      "lib/node_modules/npm/package.json",
      JSON.stringify({ name: "npm" })
    );
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    await file("bin/node", `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`);
    const bin = path.join(prefix, "bin/codex");
    await symlink(real, bin);
    await symlink(npm, path.join(prefix, "bin/npm"));
    const executor = new EngineRunnerExecutor({
      uid: 1000,
      gid: 1000,
      env: {
        HOME: home,
        PATH: process.env.PATH,
        CODEX_HOME: path.join(home, "codex"),
        CLAUDE_CONFIG_DIR: path.join(home, "claude"),
        SHELL: "/bin/sh",
      },
      engines: {
        codex: { bin },
        claude: { bin: path.join(home, "missing-claude") },
        opencode: { bin: path.join(home, "missing-opencode") },
      },
      hostCommand: [
        "bun",
        fileURLToPath(new URL("../src/main.ts", import.meta.url)),
        "runner-engine-host",
      ],
      wrap: (bin, args) => ({ bin, args }),
    });
    try {
      const plan = await executor.callHost("engine.update.inspect", {
        engine: "codex",
      });
      expect(plan).toMatchObject({
        source: "npm",
        canUpdate: true,
        probePath: bin,
        packageChannel: "@openai/codex",
      });
      expect(
        (await executor.inventory()).find((entry) => entry.id === "codex")
          ?.actions
      ).toContain("update");
      const manual = await executor.callHost("engine.update.inspect", {
        engine: "codex",
        action: "install",
      });
      expect(manual.canUpdate).toBe(false);
      expect(manual.reason).toBe(
        "Codex is installed manually on this machine; there is no automatic install here."
      );
      let records = {};
      let queue = Promise.resolve();
      const store: EngineOperationStore = {
        exclusive(work) {
          const result = queue.then(async () => {
            const next = structuredClone(records);
            const value = await work(next);
            records = next;
            return value;
          });
          queue = result.then(
            () => {},
            () => {}
          );
          return result;
        },
      };
      const calls = {
        call: (op, request) => executor.callHost(op, request),
      } as EngineCalls;
      const manager = new EngineUpdateOperations(
        store,
        engineUpdatePort(calls)
      );
      await manager.start("codex", {});
      await vi.waitFor(
        async () =>
          expect((await manager.read()).codex).toMatchObject({
            status: "succeeded",
            retryBlocked: false,
            message: "Update completed. Verified installed version 2.0.0.",
          }),
        { timeout: 10_000 }
      );
      expect(await readFile(version, "utf8")).toBe("2.0.0");
      expect((await manager.read()).codex?.output).toContain(
        "fixture npm updated"
      );
    } finally {
      executor.close();
      await rm(home, { recursive: true, force: true });
    }
  });
  it("plans bundled Node preparation without installing anything during inspection", async () => {
    const home = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "dispatch-engine-runtime-"))
    );
    const prefix = path.join(home, ".local");
    const commands: string[] = [];
    const executor = new EngineRunnerExecutor({
      uid: 1000,
      gid: 1000,
      bundledRuntime: "/fixture/runtime",
      env: { HOME: home, PATH: process.env.PATH, SHELL: "/bin/sh" },
      engines: {
        codex: {
          bin: path.join(prefix, "bin/codex"),
          install: {
            executable: "npm",
            args: [
              "install",
              "--global",
              "--prefix",
              prefix,
              "@openai/codex@latest",
            ],
          },
        },
        claude: {
          bin: path.join(prefix, "bin/claude"),
          install: {
            executable: "/fixture/runtime",
            args: ["custom-update"],
            env: { BUN_BE_BUN: "1", BUN_INSTALL: prefix },
          },
        },
        opencode: { bin: path.join(home, "missing-opencode") },
      },
      hostCommand: [
        "bun",
        fileURLToPath(new URL("../src/main.ts", import.meta.url)),
        "runner-engine-host",
      ],
      wrap: (bin, args) => {
        commands.push(bin);
        return bin === "bun" ? { bin, args } : { bin: "/bin/false", args: [] };
      },
    });
    try {
      const plan = await executor.callHost("engine.update.inspect", {
        engine: "codex",
        action: "install",
      });
      expect(plan.run).toMatchObject({
        executable: "/fixture/runtime",
        env: { BUN_BE_BUN: "1", BUN_INSTALL: prefix },
        refresh: {
          executable: "/fixture/runtime",
          args: ["add", "--global", `node-linux-${process.arch}@22`],
        },
      });
      expect(commands).not.toContain("/fixture/runtime");
      const custom = await executor.callHost("engine.update.inspect", {
        engine: "claude",
        action: "install",
      });
      expect(custom.run).toMatchObject({
        executable: "/fixture/runtime",
        args: ["custom-update"],
      });
      expect(custom.run?.refresh).toBeUndefined();
    } finally {
      executor.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
