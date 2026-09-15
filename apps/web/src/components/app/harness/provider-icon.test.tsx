// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProviderIcon, providerOf } from "./provider-icon";

describe("providerOf", () => {
  it("maps engines and engine-prefixed model ids to marks", () => {
    expect(providerOf("claude")).toBe("anthropic");
    expect(providerOf("claude/claude-opus-5")).toBe("anthropic");
    expect(providerOf("codex/gpt-5.6-sol")).toBe("openai");
    expect(providerOf("gemini/default")).toBe("google");
    expect(providerOf("opencode/anthropic/claude-sonnet-5")).toBe("opencode");
    expect(providerOf("nope/x")).toBeNull();
    expect(providerOf(null)).toBeNull();
  });
});

describe("ProviderIcon", () => {
  it("draws an svg for vendors with a mark and a text badge for OpenCode", () => {
    render(<ProviderIcon provider="codex" />);
    expect(
      screen.getByTestId("provider-icon").getAttribute("data-provider")
    ).toBe("openai");
    render(<ProviderIcon provider="opencode" />);
    expect(screen.getByText("OC").getAttribute("data-provider")).toBe(
      "opencode"
    );
  });
});
