import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { Effort } from "@dispatch/shared";
import { describe, expect, it } from "vitest";

// Resolve the SDK that the pinned ACP adapter actually uses. Do not start a
// CLI or send a prompt: intercept its spawn boundary and abort immediately.
const adapterRequire = createRequire(
  createRequire(import.meta.url).resolve(
    "@agentclientprotocol/claude-agent-acp/dist/lib.js"
  )
);
const sdkUrl = pathToFileURL(
  adapterRequire.resolve("@anthropic-ai/claude-agent-sdk")
).href;

describe("Claude SDK launch effort argv", () => {
  it.each(["low", "medium", "high", "xhigh", "max", null] as const)(
    "emits exactly the resolved %s effort, or no flag when unset",
    async (effort) => {
      const { query } = (await import(sdkUrl)) as {
        query: (input: {
          prompt: string;
          options: {
            effort?: Effort;
            pathToClaudeCodeExecutable: string;
            env: Record<string, string>;
            spawnClaudeCodeProcess: (input: { args: string[] }) => never;
          };
        }) => AsyncIterable<unknown>;
      };
      let args: string[] | undefined;
      const captured = new Error("spawn captured; no CLI started");
      async function capture() {
        for await (const _message of query({
          prompt: "Never sent",
          options: {
            ...(effort === null ? {} : { effort }),
            pathToClaudeCodeExecutable: "/tmp/dispatch-test-no-claude",
            env: {},
            spawnClaudeCodeProcess: (input) => {
              args = input.args;
              throw captured;
            },
          },
        })) {
          throw new Error(
            "The SDK should not produce a message without spawning"
          );
        }
      }
      await expect(capture()).rejects.toThrow(captured.message);
      expect(args).toBeDefined();
      // SDK uses --effort=value, the CLI's equivalent of --effort value.
      expect(args!.filter((arg) => arg.startsWith("--effort"))).toEqual(
        effort === null ? [] : [`--effort=${effort}`]
      );
    }
  );
});
