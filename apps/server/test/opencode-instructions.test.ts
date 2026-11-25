import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hostFile } from "@dispatch/runner-client/host-framing";
import { openCodeInstructionsEnv } from "@dispatch/runner/host/opencode-instructions";

describe("OpenCode instructions", () => {
  it("adds private native instructions without replacing provider or user rules, including on resume", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dispatch-instructions-"));
    try {
      const env = {
        OPENCODE_CONFIG_CONTENT:
          '{ // user config\n "instructions": ["user.md"], "model": "ollama/qwen", }',
        OPENCODE_CONFIG: "/custom/opencode.json",
      };
      const initial = await openCodeInstructionsEnv(
        hostFile(dir, "instructions"),
        "Dispatch guidance",
        env
      );
      const config = JSON.parse(initial.OPENCODE_CONFIG_CONTENT!);
      expect(config.model).toBe("ollama/qwen");
      expect(config.instructions).toEqual([
        "user.md",
        path.join(dir, "dispatch-instructions.md"),
      ]);
      expect(initial.OPENCODE_CONFIG).toBe(env.OPENCODE_CONFIG);
      const resumed = await openCodeInstructionsEnv(
        hostFile(dir, "instructions"),
        "Updated persona",
        initial
      );
      expect(JSON.parse(resumed.OPENCODE_CONFIG_CONTENT!).instructions).toEqual(
        config.instructions
      );
      expect(await readFile(config.instructions[1], "utf8")).toBe(
        "Updated persona"
      );
      expect(env.OPENCODE_CONFIG_CONTENT).toContain("// user config");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("rejects malformed existing configuration instead of discarding it", async () => {
    await expect(
      openCodeInstructionsEnv("/unused/dispatch-instructions.md", "rules", {
        OPENCODE_CONFIG_CONTENT: "{",
      })
    ).rejects.toThrow("configuration object");
    await expect(
      openCodeInstructionsEnv("/unused/dispatch-instructions.md", "rules", {
        OPENCODE_CONFIG_CONTENT: '{"instructions":"x"}',
      })
    ).rejects.toThrow("array of paths");
  });
});
