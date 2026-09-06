// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  ProviderIcon,
  providerOf,
  providerOfConfigValue,
} from "./provider-icon";

afterEach(cleanup);

describe("provider icons", () => {
  it("knows the four providers and their aliases", () => {
    expect(providerOf("openai/gpt-5.6-sol")).toBe("openai");
    expect(providerOf("deepseek-official/deepseek-v4-flash")).toBe("deepseek");
    expect(providerOf("anthropic")).toBe("anthropic");
    expect(providerOf("gemini")).toBe("google");
    expect(providerOf("mistral/large")).toBeNull();
    expect(providerOfConfigValue('["openai","gpt-5.6-sol"]')).toBe("openai");
    expect(providerOfConfigValue(undefined)).toBeNull();
  });

  it("draws a mark for a known provider and nothing for an unknown one", () => {
    const { container, rerender } = render(<ProviderIcon provider="openai" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("data-provider")).toBe("openai");
    expect(svg?.querySelector("path")).not.toBeNull();
    rerender(<ProviderIcon provider="nope" />);
    expect(container.querySelector("svg")).toBeNull();
  });
});
