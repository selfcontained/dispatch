import { ClaudeAcpAgent } from "@agentclientprotocol/claude-agent-acp/dist/acp-agent.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

describe("pinned Claude adapter launch effort", () => {
  it.each(["low", "medium", "high", "xhigh", "max", null] as const)(
    "forwards %s through session creation without replacing project settings with a recommendation",
    async (effort) => {
      const cwd = await mkdtemp(
        path.join(os.tmpdir(), "dispatch-effort-adapter-")
      );
      await mkdir(path.join(cwd, ".claude"));
      await writeFile(
        path.join(cwd, ".claude/settings.json"),
        JSON.stringify({ effortLevel: "low" })
      );
      const adapter = new ClaudeAcpAgent(
        { sessionUpdate: async () => {} } as never,
        { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
      );
      // Exercise the installed adapter's real session creation and SDK, but
      // intercept spawning: no executable, credentials or model call is used.
      const createSession = Reflect.get(adapter, "createSession").bind(
        adapter
      ) as (params: unknown) => Promise<unknown>;
      let args: string[] | undefined;
      try {
        await expect(
          createSession({
            cwd,
            mcpServers: [],
            _meta: {
              claudeCode: {
                options: {
                  ...(effort === null ? {} : { effort }),
                  spawnClaudeCodeProcess: (options: { args: string[] }) => {
                    args = options.args;
                    throw new Error("adapter spawn captured");
                  },
                },
              },
            },
          })
        ).rejects.toThrow("adapter spawn captured");
        expect(args).toBeDefined();
        expect(args!.filter((arg) => arg.startsWith("--effort"))).toEqual(
          effort === null ? [] : [`--effort=${effort}`]
        );
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  );
});
