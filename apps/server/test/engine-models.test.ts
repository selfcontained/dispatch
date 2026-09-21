import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  modelOptionOf,
  recordEngineModels,
} from "../src/agents/engine-models.js";
import {
  forgetLearnedAgentModels,
  getAgentModelOptions,
} from "../src/shared/agent-models.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as import("fastify").FastifyBaseLogger;

const modelOption = (
  currentValue: string,
  options: SessionConfigOption extends infer T
    ? T extends { type: "select" }
      ? T["options"]
      : never
    : never
): SessionConfigOption => ({
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue,
  options,
});

describe("modelOptionOf", () => {
  it("reads a flat model option", () => {
    expect(
      modelOptionOf([
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "code",
          options: [{ value: "code", name: "Code" }],
        },
        modelOption("gpt-5.5", [
          { value: "gpt-5.5", name: "GPT-5.5" },
          { value: "gpt-6-astra", name: "GPT-6 Astra" },
        ]),
      ])
    ).toEqual({
      current: "gpt-5.5",
      choices: [
        { id: "gpt-5.5", label: "GPT-5.5" },
        { id: "gpt-6-astra", label: "GPT-6 Astra" },
      ],
    });
  });

  it("leaves the engine's own default entry out; the picker has one", () => {
    expect(
      modelOptionOf([
        modelOption("claude-fable-5-1[1m]", [
          { value: "default", name: "Default (recommended)" },
          { value: "claude-fable-5-1[1m]", name: "Fable 5.1" },
        ]),
      ])
    ).toEqual({
      current: "claude-fable-5-1[1m]",
      choices: [{ id: "claude-fable-5-1[1m]", label: "Fable 5.1" }],
    });
  });

  it("flattens grouped choices in the engine's order, naming each within its group", () => {
    expect(
      modelOptionOf([
        modelOption("gpt-6-astra", [
          {
            group: "gpt",
            name: "GPT",
            options: [
              { value: "gpt-6-astra", name: "6 Astra" },
              { value: "gpt-5.5", name: "GPT 5.5" },
            ],
          },
          {
            group: "older",
            name: "Older",
            options: [{ value: "gpt-4.1", name: "Older 4.1" }],
          },
        ]),
      ])?.choices
    ).toEqual([
      { id: "gpt-6-astra", label: "GPT 6 Astra" },
      { id: "gpt-5.5", label: "GPT 5.5" },
      { id: "gpt-4.1", label: "Older 4.1" },
    ]);
  });

  it("is null when the engine publishes no model option", () => {
    expect(modelOptionOf([])).toBeNull();
    expect(
      modelOptionOf([
        { id: "model", name: "Model", type: "boolean", currentValue: true },
      ])
    ).toBeNull();
  });
});

describe("recordEngineModels", () => {
  afterEach(() => forgetLearnedAgentModels());

  const pool = () => ({ query: vi.fn().mockResolvedValue({ rows: [] }) });

  it("stores the running model on the agent and the list for its type", async () => {
    const p = pool();
    const result = await recordEngineModels(
      { pool: p as never, logger },
      { id: "agt_1", type: "claude", model: null },
      [
        modelOption("claude-opus-5", [
          { value: "claude-opus-5", name: "Opus 5" },
          { value: "claude-sonnet-5", name: "Sonnet 5" },
        ]),
      ]
    );
    expect(result).toEqual({ modelChanged: true });
    expect(getAgentModelOptions("claude").map((o) => o.id)).toEqual([
      "claude-opus-5",
      "claude-sonnet-5",
    ]);
    const sql = p.query.mock.calls.map((c) => String(c[0]));
    expect(sql.some((q) => q.includes("INSERT INTO settings"))).toBe(true);
    const update = p.query.mock.calls.find((c) =>
      String(c[0]).includes("UPDATE agents SET model")
    );
    expect(update?.[1]).toEqual(["agt_1", "claude-opus-5"]);
    const stored = p.query.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO settings")
    )?.[1] as [string, string];
    expect(stored[0]).toBe("agent_models:claude");
    expect(JSON.parse(stored[1]).models).toHaveLength(2);
  });

  it("leaves the agent alone when the engine runs what it already says", async () => {
    const p = pool();
    const result = await recordEngineModels(
      { pool: p as never, logger },
      { id: "agt_1", type: "codex", model: "gpt-5.5" },
      [modelOption("gpt-5.5", [{ value: "gpt-5.5", name: "GPT-5.5" }])]
    );
    expect(result).toEqual({ modelChanged: false });
    expect(
      p.query.mock.calls.some((c) => String(c[0]).includes("UPDATE agents"))
    ).toBe(false);
  });

  it("does nothing for an engine with no model option", async () => {
    const p = pool();
    const result = await recordEngineModels(
      { pool: p as never, logger },
      { id: "agt_1", type: "claude", model: null },
      []
    );
    expect(result).toEqual({ modelChanged: false });
    expect(p.query).not.toHaveBeenCalled();
  });
});
