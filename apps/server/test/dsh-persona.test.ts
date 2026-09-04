import { describe, expect, it } from "vitest";

import { buildDshPersona } from "../src/agents/dsh/persona.js";

const base = {
  id: "agt_p",
  type: "dsh" as const,
  agentArgs: [] as string[],
  persona: null,
  autoReview: false,
};

describe("buildDshPersona", () => {
  it("starts with the Dispatch launch guidance", () => {
    const text = buildDshPersona({
      agent: base,
      personalityPrompt: null,
      trimmedGuidance: false,
      chatSurface: false,
      suggestSessionRename: false,
    });
    expect(text).toContain("dispatch_event");
  });

  it("appends the active personality for a standard agent", () => {
    const text = buildDshPersona({
      agent: base,
      personalityPrompt: "Be terse.",
      trimmedGuidance: false,
      chatSurface: true,
      suggestSessionRename: false,
    });
    expect(text.endsWith("Be terse.")).toBe(true);
  });

  it("prefers the persona brief stored in agentArgs over a personality", () => {
    const text = buildDshPersona({
      agent: {
        ...base,
        persona: "security-review",
        agentArgs: ["--append-system-prompt", "You review for security."],
      },
      personalityPrompt: "Be terse.",
      trimmedGuidance: false,
      chatSurface: false,
      suggestSessionRename: false,
    });
    expect(text).toContain("You review for security.");
    expect(text).not.toContain("Be terse.");
  });
});
