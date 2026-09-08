import { describe, expect, it } from "vitest";
import type { HarnessConfigOption } from "@dispatch/shared";

import {
  catalogFromConfigOptions,
  filterConfigOptionsByKeys,
  modelIdFromValue,
} from "../src/agents/harness/supervisor.js";

const options: HarnessConfigOption[] = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: '["openai","gpt-5.2"]',
    options: [
      {
        group: "deepseek-official",
        name: "DeepSeek",
        options: [
          {
            value: '["deepseek-official","deepseek-v4-flash"]',
            name: "DeepSeek-V4-Flash",
          },
        ],
      },
      {
        group: "openai",
        name: "OpenAI",
        options: [
          { value: '["openai","gpt-5.2"]', name: "GPT-5.2" },
          { value: '["openai","gpt-5.6-sol"]', name: "GPT-5.6 Sol" },
        ],
      },
      {
        group: "mystery",
        name: "Mystery",
        options: [{ value: '["mystery","m1"]', name: "M1" }],
      },
    ],
  },
  {
    id: "reasoning_effort",
    name: "Reasoning effort",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
  },
];

describe("filterConfigOptionsByKeys", () => {
  it("drops model groups whose provider key is missing, keeps unknown routes", () => {
    const out = filterConfigOptionsByKeys(options, { OPENAI_API_KEY: "x" });
    const model = out.find((o) => o.id === "model");
    expect(model?.options.map((g) => (g as { name: string }).name)).toEqual([
      "OpenAI",
      "Mystery",
    ]);
    // OpenAI offers only the current generation, plus whatever is running.
    const openai = model?.options[0] as { options: { name: string }[] };
    expect(openai.options.map((c) => c.name)).toEqual([
      "GPT-5.2",
      "GPT-5.6 Sol",
    ]);
    // Effort passes through untouched.
    expect(out.find((o) => o.id === "reasoning_effort")).toBe(options[1]);
  });
});

describe("filterConfigOptionsByKeys with stored sign-ins", () => {
  const withCodex: HarnessConfigOption[] = [
    {
      ...options[0],
      options: [
        ...options[0].options,
        {
          group: "openai-codex",
          name: "ChatGPT (Codex)",
          options: [
            { value: '["openai-codex","gpt-5.4"]', name: "GPT-5.4" },
            { value: '["openai-codex","gpt-5.6-sol"]', name: "GPT-5.6 Sol" },
          ],
        },
      ],
    },
  ];
  const names = (out: HarnessConfigOption[]) =>
    (out[0].options as { name: string }[]).map((g) => g.name);

  it("hides the ChatGPT route until its sign-in is stored", () => {
    expect(names(filterConfigOptionsByKeys(withCodex, {}))).toEqual([
      "Mystery",
    ]);
    expect(
      names(
        filterConfigOptionsByKeys(
          withCodex,
          {},
          new Set(["llm-pi-ai/openai-codex"])
        )
      )
    ).toEqual(["Mystery", "ChatGPT (Codex)"]);
  });

  it("offers only the current generation on the ChatGPT route", () => {
    const out = filterConfigOptionsByKeys(
      withCodex,
      {},
      new Set(["llm-pi-ai/openai-codex"])
    );
    const codex = (
      out[0].options as { name: string; options: { name: string }[] }[]
    ).find((g) => g.name === "ChatGPT (Codex)");
    expect(codex?.options.map((c) => c.name)).toEqual(["GPT-5.6 Sol"]);
  });
});

describe("catalogFromConfigOptions", () => {
  it("flattens groups into provider/model rows with the group in the label", () => {
    expect(
      catalogFromConfigOptions(
        filterConfigOptionsByKeys(options, { OPENAI_API_KEY: "x" })
      )
    ).toEqual([
      { id: "openai/gpt-5.2", label: "GPT-5.2", group: "OpenAI" },
      { id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", group: "OpenAI" },
      { id: "mystery/m1", label: "M1", group: "Mystery" },
    ]);
    expect(catalogFromConfigOptions([options[1]])).toEqual([]);
  });
});

describe("modelIdFromValue", () => {
  it("reads dsh's JSON pair and passes a plain id through", () => {
    expect(modelIdFromValue('["openai","gpt-5.6-terra"]')).toBe(
      "openai/gpt-5.6-terra"
    );
    expect(modelIdFromValue("openai/gpt-5.2")).toBe("openai/gpt-5.2");
    expect(modelIdFromValue("high")).toBeNull();
  });
});
