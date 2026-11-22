// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentModelSelect } from "./agent-model-select";

const OPTIONS = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
] as const;

afterEach(cleanup);

describe("AgentModelSelect", () => {
  it("shows the selected model", () => {
    render(
      <AgentModelSelect value="sonnet" options={OPTIONS} onChange={vi.fn()} />
    );
    expect(screen.getByTestId("create-agent-model").textContent).toContain(
      "Sonnet"
    );
  });

  // An empty trigger reads as a broken control, when what it means is
  // "no model chosen" — that state has to render as Default.
  it.each([null, "", "retired-model-id"])(
    "falls back to Default for %j",
    (value) => {
      render(
        <AgentModelSelect value={value} options={OPTIONS} onChange={vi.fn()} />
      );
      expect(screen.getByTestId("create-agent-model").textContent).toContain(
        "Default"
      );
    }
  );

  it("shows Use engine setting when the catalog has models but no default", () => {
    render(
      <AgentModelSelect
        value={null}
        options={OPTIONS}
        catalogDefault={null}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByTestId("create-agent-model").textContent).toBe(
      "Use engine setting"
    );
  });

  it("shows a saved model that was turned off", () => {
    render(
      <AgentModelSelect
        value="haiku"
        options={OPTIONS}
        savedOption={{ id: "haiku", label: "Haiku" }}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByTestId("create-agent-model").textContent).toContain(
      "Haiku"
    );
  });

  it("disables the model picker while the catalog loads", () => {
    render(
      <AgentModelSelect value={null} options={[]} onChange={vi.fn()} loading />
    );
    const trigger = screen.getByTestId("create-agent-model");
    expect(trigger.textContent).toBe("Loading models…");
    expect(trigger).toHaveProperty("disabled", true);
  });
});
