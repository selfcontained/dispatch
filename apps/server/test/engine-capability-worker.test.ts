import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { EngineHostCall } from "@dispatch/runner-protocol/engine-management";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

it("discovers models, effort and installed plugins from two workload homes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "runner-capability-"));
  try {
    const adapter = path.join(root, "adapter.mjs");
    const cli = path.join(root, "cli.mjs");
    const homes = [path.join(root, "first"), path.join(root, "second")];
    await Promise.all(homes.map((home) => mkdir(home)));
    await writeFile(path.join(homes[0]!, "installed"), "1.2.3");
    await writeFile(
      adapter,
      `
import { basename } from "node:path";
import { createInterface } from "node:readline";
const home = basename(process.env.HOME);
let model = home + "/default";
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === "session/set_config_option") model = params.value;
  const result = method === "initialize" ? { protocolVersion: 1 } : {
    sessionId: "fixture",
    configOptions: [
      { id: "model", name: "Model", category: "model", type: "select",
        currentValue: model, options: [
          { value: home + "/default", name: home + " default" },
          { value: home + "/alternate", name: home + " alternate" },
        ] },
      { id: "effort", name: "Effort", category: "thought_level", type: "select",
        currentValue: home, options: [{ value: home, name: home, description: "Full described effort fixture" }] },
    ],
  };
  console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
`
    );
    await writeFile(
      cli,
      `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const marker = join(process.env.HOME, "installed");
const args = process.argv.slice(2).join(" ");
if (args === "plugin list --json") {
  const installed = existsSync(marker) ? [{
    pluginId: "dispatch@dispatch", version: readFileSync(marker, "utf8"), enabled: true
  }] : [];
  console.log(JSON.stringify({ installed }));
} else if (args === "plugin marketplace list --json") {
  console.log(JSON.stringify({ marketplaces: [{ name: "dispatch", root: process.env.HOME }] }));
} else if (args.startsWith("plugin add ")) {
  writeFileSync(marker, "2.0.0");
}
`,
      { mode: 0o755 }
    );
    async function worker(home: string, call: EngineHostCall) {
      const child = execute("bun", [main, "runner-engine-host"], {
        cwd: home,
        env: { HOME: home, PATH: process.env.PATH },
        timeout: 20_000,
      });
      child.child.stdin!.end(
        JSON.stringify({
          id: 1,
          call,
          bins: { claude: cli, codex: cli, opencode: cli },
          adapter: { bin: process.execPath, args: [adapter] },
        }) + "\n"
      );
      return JSON.parse((await child).stdout.trim());
    }
    const plugin = { engine: "codex", plugin: "dispatch@dispatch" } as const;
    const [first, second, installed, absent] = await Promise.all([
      worker(homes[0]!, { op: "engine.models", request: { engine: "codex" } }),
      worker(homes[1]!, {
        op: "engine.models",
        request: { engine: "opencode", model: "second/alternate" },
      }),
      worker(homes[0]!, { op: "engine.plugin.status", request: plugin }),
      worker(homes[1]!, { op: "engine.plugin.status", request: plugin }),
    ]);
    expect(first.data).toMatchObject({
      defaultModel: "first/default",
      models: [
        {
          id: "first/default",
          effort: [
            { value: "first", description: "Full described effort fixture" },
          ],
        },
        { id: "first/alternate" },
      ],
    });
    expect(second.data).toMatchObject({
      defaultModel: "second/default",
      models: [
        { id: "second/default" },
        { id: "second/alternate", effort: [{ value: "second" }] },
      ],
    });
    expect(installed.data).toMatchObject({
      currentVersion: "1.2.3",
      installed: true,
    });
    expect(absent.data).toMatchObject({ installed: false });
    expect(
      (
        await worker(homes[1]!, {
          op: "engine.plugin.apply",
          request: { ...plugin, action: "install", requestId: "fixture" },
        })
      ).data
    ).toMatchObject({ currentVersion: "2.0.0", installed: true });
    expect(
      (
        await worker(homes[1]!, {
          op: "engine.plugin.status",
          request: { ...plugin, plugin: "other@marketplace" },
        })
      ).error
    ).toMatchObject({ code: "unsupported" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
