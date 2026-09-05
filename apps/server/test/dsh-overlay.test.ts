import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildOverlayYaml,
  splitModelId,
  writeOverlay,
} from "../src/agents/dsh/overlay.js";

type Row = { id: string; config: Record<string, unknown> };

describe("splitModelId", () => {
  it("splits provider/model", () => {
    expect(splitModelId("openai/gpt-5.2")).toEqual({
      provider: "openai",
      model: "gpt-5.2",
    });
  });

  it("rejects ids without a provider", () => {
    expect(() => splitModelId("gpt-5.2")).toThrow("provider/model");
    expect(() => splitModelId("openai/")).toThrow("provider/model");
  });
});

describe("buildOverlayYaml", () => {
  it("emits llm routes, persona, and default model rows", () => {
    const rows = parse(
      buildOverlayYaml({
        model: "openai/gpt-5.2",
        persona: "You are {{model}} in {{cwd}}.",
      })
    ) as Row[];
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.config]));
    expect(byId["llm-pi-ai"]).toEqual({
      providers: {
        openai: { apiKeyEnv: "OPENAI_API_KEY", displayName: "OpenAI" },
      },
    });
    expect(byId["system-prompt"]).toEqual({
      persona: "You are {{model}} in {{cwd}}.",
    });
    expect(byId["agent-default-model"]).toEqual({
      provider: "openai",
      model: "gpt-5.2",
    });
    expect(byId["acp"]).toEqual({ provider: "openai", model: "gpt-5.2" });
  });

  it("omits model rows when no model is chosen", () => {
    const rows = parse(
      buildOverlayYaml({ model: null, persona: "p" })
    ) as Row[];
    expect(rows.map((r) => r.id)).toEqual(["llm-pi-ai", "system-prompt"]);
  });

  it("lets the caller replace the provider routes", () => {
    const rows = parse(
      buildOverlayYaml({
        model: "local/qwen3-coder",
        persona: "p",
        providers: {
          local: {
            api: "openai-completions",
            baseURL: "http://127.0.0.1:11434/v1",
            models: [{ id: "qwen3-coder", contextWindow: 131072 }],
          },
        },
      })
    ) as Row[];
    const llm = rows.find((r) => r.id === "llm-pi-ai")?.config as {
      providers: Record<string, unknown>;
    };
    expect(Object.keys(llm.providers)).toEqual(["local"]);
  });
});

describe("writeOverlay", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("writes <dir>/<agentId>.patch.yml, creating the directory", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "dsh-overlay-"));
    const nested = path.join(dir, "overlays");
    const file = await writeOverlay(nested, "agt_1", {
      model: null,
      persona: "p",
    });
    expect(file).toBe(path.join(nested, "agt_1.patch.yml"));
    expect(await readFile(file, "utf8")).toContain("system-prompt");
  });
});
