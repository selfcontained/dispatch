import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runLifecycleHook } from "../src/agents/lifecycle-hooks.js";
import type { AgentRecord } from "../src/agents/types.js";
import { repoCommandEnvironment } from "../src/shared/lib/tool-environment.js";
import { loadRepoTools } from "../src/shared/mcp/repo-tools.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "dispatch-repo-path-"))
  );
  roots.push(root);
  const bin = path.join(root, ".nvm", "versions", "node", "v22.1.2", "bin");
  await mkdir(bin, { recursive: true });
  for (const [name, script] of Object.entries({
    node: '#!/bin/sh\nprintf "node-ok\\n"\n',
    // Exercise a subprocess shebang, not just resolution of the top-level tool.
    pnpm: "#!/usr/bin/env node\n",
    bun: '#!/bin/sh\nprintf "bun-ok\\n"\n',
  })) {
    await writeFile(path.join(bin, name), script);
    await chmod(path.join(bin, name), 0o755);
  }
  await mkdir(path.join(root, ".dispatch"));
  await writeFile(
    path.join(root, "dev"),
    `#!/bin/sh
set -eu
command -v node >/dev/null
command -v pnpm >/dev/null
command -v bun >/dev/null
pnpm
printf '%s:%s:%s\\n' "$1" "$DISPATCH_AGENT_ID" "$PWD"
`
  );
  await chmod(path.join(root, "dev"), 0o755);
  await writeFile(
    path.join(root, ".dispatch", "tools.json"),
    JSON.stringify({
      tools: ["up", "restart", "status", "down"].map((command) => ({
        name: `dev_${command}`,
        description: `Dev ${command}`,
        command: ["./dev", command],
      })),
      hooks: { stop: { command: ["./dev", "down"] } },
    })
  );
  vi.stubEnv("HOME", root);
  vi.stubEnv("PATH", "/usr/bin:/bin");
  return { root, bin };
}

describe("repo command environment", () => {
  it("discovers nvm runtimes for every dev tool under a restricted service PATH", async () => {
    const { root } = await fixture();
    const tools = await loadRepoTools(root);
    for (const tool of tools) {
      const result = await tool.run({ agentId: "agt_path", repoRoot: root });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        `node-ok\n${tool.name.slice(9)}:agt_path:${root}`
      );
    }
    expect(process.env.PATH).toBe("/usr/bin:/bin");
  });

  it("prefers newer nvm Node for pnpm shebangs while retaining an inherited selection", async () => {
    const { root, bin } = await fixture();
    const oldBin = path.join(
      root,
      ".nvm",
      "versions",
      "node",
      "v16.20.2",
      "bin"
    );
    await mkdir(oldBin, { recursive: true });
    await writeFile(
      path.join(oldBin, "node"),
      '#!/bin/sh\nprintf "Node too old for pnpm\\n" >&2\nexit 42\n'
    );
    await chmod(path.join(oldBin, "node"), 0o755);
    // Numeric ordering must also keep v9 below v22, despite lexical order.
    const ancientBin = path.join(
      root,
      ".nvm",
      "versions",
      "node",
      "v9.9.9",
      "bin"
    );
    await mkdir(ancientBin, { recursive: true });
    await writeFile(path.join(ancientBin, "node"), "#!/bin/sh\nexit 43\n");
    await chmod(path.join(ancientBin, "node"), 0o755);
    const [tool] = await loadRepoTools(root);
    const result = await tool.run({ agentId: "agt_path", repoRoot: root });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("node-ok");
    const entries = repoCommandEnvironment("agt_path").PATH!.split(
      path.delimiter
    );
    expect(entries.indexOf(bin)).toBeLessThan(entries.indexOf(oldBin));
    expect(entries.indexOf(oldBin)).toBeLessThan(entries.indexOf(ancientBin));

    // A caller explicitly selecting the older Node must still win.
    vi.stubEnv("PATH", `${oldBin}:/usr/bin:/bin`);
    const selected = await tool.run({ agentId: "agt_path", repoRoot: root });
    expect(selected.exitCode).toBe(42);
    expect(selected.stderr).toBe("Node too old for pnpm");
  });

  it("passes the real dispatch-dev preflight for all dev commands", async () => {
    const { root } = await fixture();
    const devScript = path.resolve(
      import.meta.dirname,
      "../../../bin/dispatch-dev"
    );
    // --help runs preflight and argument parsing without starting any services.
    await writeFile(
      path.join(root, ".dispatch", "tools.json"),
      JSON.stringify({
        tools: ["up", "restart", "status", "down"].map((command) => ({
          name: `dev_${command}`,
          description: `Dev ${command}`,
          command: [devScript, command, "--help"],
        })),
      })
    );
    for (const tool of await loadRepoTools(root)) {
      const result = await tool.run({ agentId: "agt_path", repoRoot: root });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Usage: dispatch-dev");
      expect(result.stderr).toBe("");
    }
  });

  it("gives the stop hook the same discovery environment", async () => {
    const { root } = await fixture();
    const logger = { info: vi.fn(), warn: vi.fn() };
    await expect(
      runLifecycleHook(
        "stop",
        {
          id: "agt_path",
          cwd: root,
          worktreePath: null,
          workspacePath: null,
        } as AgentRecord,
        logger as unknown as import("fastify").FastifyBaseLogger
      )
    ).resolves.toBeUndefined();
    expect(logger.info).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("preserves inherited PATH precedence, deduplicates, and retains other env values", async () => {
    const { root, bin } = await fixture();
    const inherited = {
      HOME: root,
      PATH: `/custom/bin:${bin}:/usr/bin`,
      KEEP: "value",
      DISPATCH_AGENT_ID: "old",
    };
    const env = repoCommandEnvironment("agt_new", inherited);
    expect(env.PATH?.split(path.delimiter).slice(0, 3)).toEqual([
      "/custom/bin",
      bin,
      "/usr/bin",
    ]);
    expect(
      env.PATH?.split(path.delimiter).filter((dir) => dir === bin)
    ).toHaveLength(1);
    expect(env.KEEP).toBe("value");
    expect(env.DISPATCH_AGENT_ID).toBe("agt_new");
    expect(inherited.DISPATCH_AGENT_ID).toBe("old");
  });
});
