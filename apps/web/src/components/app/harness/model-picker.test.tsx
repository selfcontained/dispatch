// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { HarnessConfigOption } from "@dispatch/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeValue, encodeValue, ModelPicker } from "./model-picker";

const model: HarnessConfigOption = {
  id: "model",
  name: "Model",
  type: "select",
  currentValue: '["openai","gpt-5.2"]',
  options: [
    {
      group: "openai",
      name: "OpenAI",
      options: [
        { value: '["openai","gpt-5.2"]', name: "GPT-5.2" },
        { value: '["openai","gpt-5.6-sol"]', name: "GPT-5.6 Sol" },
      ],
    },
  ],
};
// dsh's effort list starts with a "Provider default" whose value is "".
const effort: HarnessConfigOption = {
  id: "reasoning_effort",
  name: "Reasoning effort",
  type: "select",
  currentValue: "",
  options: [
    { value: "", name: "Provider default" },
    { value: "high", name: "High" },
  ],
};

afterEach(cleanup);

describe("ModelPicker", () => {
  it("renders an effort list with an empty-valued default without throwing", () => {
    render(
      <ModelPicker
        open
        onOpenChange={vi.fn()}
        model={model}
        effort={effort}
        running
        saving={false}
        error={null}
        onApply={vi.fn(async () => undefined)}
      />
    );
    expect(screen.getByTestId("harness-model-picker")).toBeTruthy();
    expect(screen.getByTestId("harness-effort-select").textContent).toContain(
      "Provider default"
    );
    // Nothing changed yet, so Apply waits.
    expect(
      (screen.getByTestId("harness-model-apply") as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("explains and disables when the session is not running", () => {
    render(
      <ModelPicker
        open
        onOpenChange={vi.fn()}
        model={model}
        effort={effort}
        running={false}
        saving={false}
        error={null}
        onApply={vi.fn(async () => undefined)}
      />
    );
    expect(screen.getByTestId("harness-model-picker").textContent).toContain(
      "no live session"
    );
    fireEvent.click(screen.getByTestId("harness-model-apply"));
  });

  it("round-trips the empty value through the stand-in", () => {
    expect(decodeValue(encodeValue(""))).toBe("");
    expect(encodeValue("high")).toBe("high");
  });
});
