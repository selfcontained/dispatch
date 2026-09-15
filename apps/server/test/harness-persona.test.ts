import { describe, expect, it } from "vitest";

import {
  buildHarnessPersona,
  HARNESS_CHAT_RULE,
} from "../src/agents/harness/persona.js";

const base = {
  id: "agt_p",
  type: "dispatch" as const,
  agentArgs: [] as string[],
  persona: null,
  autoReview: false,
};

describe("buildHarnessPersona", () => {
  it("starts with the Dispatch launch guidance", () => {
    const text = buildHarnessPersona({
      agent: base,
      personalityPrompt: null,
      trimmedGuidance: false,
      suggestSessionRename: false,
    });
    expect(text).toContain("dispatch_event");
    expect(text).toContain(HARNESS_CHAT_RULE);
    expect(text).not.toContain("Send every user-facing reply");
  });

  it("appends the active personality for a standard agent", () => {
    const text = buildHarnessPersona({
      agent: base,
      personalityPrompt: "Be terse.",
      trimmedGuidance: false,
      suggestSessionRename: false,
    });
    expect(text.endsWith("Be terse.")).toBe(true);
  });

  it("prefers the persona brief stored in agentArgs over a personality", () => {
    const text = buildHarnessPersona({
      agent: {
        ...base,
        persona: "security-review",
        agentArgs: ["--append-system-prompt", "You review for security."],
      },
      personalityPrompt: "Be terse.",
      trimmedGuidance: false,
      suggestSessionRename: false,
    });
    expect(text).toContain("You review for security.");
    expect(text).not.toContain("Be terse.");
  });
});

describe("buildHarnessPersona for a job run", () => {
  it("names the job tools in the guidance", () => {
    const text = buildHarnessPersona({
      agent: base,
      personalityPrompt: null,
      trimmedGuidance: false,
      suggestSessionRename: false,
      jobRunId: "run_42",
    });
    expect(text).toContain("Dispatch job startup");
  });
});
