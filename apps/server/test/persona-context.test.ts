import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractPersonaContext,
  firstPromptContext,
  PERSONA_CONTEXT_ARG,
  preparePersonaContext,
} from "../src/agents/acp/persona-context.js";
import { MAX_PERSONA_PROMPT_BYTES } from "../src/personas/loader.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("persona context delivery", () => {
  it("extracts persisted context without changing legacy launches", () => {
    expect(
      extractPersonaContext(["--append-system-prompt", "legacy"])
    ).toBeNull();
    expect(extractPersonaContext([PERSONA_CONTEXT_ARG, "full context"])).toBe(
      "full context"
    );
  });
  it("keeps exactly 64KiB inline, including multibyte text", async () => {
    const context = "é".repeat(MAX_PERSONA_PROMPT_BYTES / 2);
    expect(await preparePersonaContext("unused", context)).toBe(context);
  });
  it("preserves all oversized content in a private file and recreates it on restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "persona-context-"));
    roots.push(root);
    const context = "🙂".repeat(MAX_PERSONA_PROMPT_BYTES / 4) + "FINAL RULE";
    const file = path.join(root, "persona-context.md");
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt = await preparePersonaContext(root, context);
      expect(prompt).toContain(JSON.stringify(file));
      expect(prompt).toContain("read the entire");
      expect(prompt).toContain("If you cannot read it");
      expect(Buffer.byteLength(prompt!)).toBeLessThan(MAX_PERSONA_PROMPT_BYTES);
      expect(await readFile(file, "utf8")).toBe(context);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      await rm(file);
    }
  });
  it.each(["system_prompt", "first_prompt", "instructions_file"] as const)(
    "separates fixed guidance from the context for %s",
    (delivery) => {
      const result = firstPromptContext(
        delivery,
        "FIXED GUIDANCE",
        "FULL CONTEXT"
      );
      expect(result).toContain("FULL CONTEXT");
      expect(result?.includes("FIXED GUIDANCE")).toBe(
        delivery === "first_prompt"
      );
      expect(firstPromptContext(delivery, null, undefined)).toBeNull();
    }
  );
});
