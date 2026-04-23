import { describe, it, expect } from "vitest";

import { buildLaunchPersonaResponseText } from "../src/shared/mcp/server.js";

describe("buildLaunchPersonaResponseText", () => {
  const persona = "backend-security-review";
  const agentId = "agt_test123";
  const base = `Launched persona "${persona}" as agent ${agentId}.`;

  it("returns only the base confirmation when allowRecheck is false", () => {
    const text = buildLaunchPersonaResponseText(persona, agentId, false);
    expect(text).toBe(base);
  });

  it("appends the parent driver-loop guidance when allowRecheck is true", () => {
    const text = buildLaunchPersonaResponseText(persona, agentId, true);

    expect(text.startsWith(base)).toBe(true);
    expect(text).toContain("Review was launched with recheck enabled");
    expect(text).toContain("dispatch_get_feedback");
    expect(text).toContain("dispatch_resolve_feedback");
    expect(text).toContain("dispatch_submit_resolution");
    expect(text).toContain("respondsToFeedbackId");
  });

  it("describes the actual polling contract — round-2 items, not a verdict signal", () => {
    // Regression guard: dispatch_get_feedback does not surface
    // persona_review.verdict/status, so the guidance must not promise an
    // end-of-poll verdict signal. See CRU-133 review (feedback #1113).
    const text = buildLaunchPersonaResponseText(persona, agentId, true);
    expect(text).not.toMatch(/verdict is complete/i);
    expect(text).toContain("linked via respondsToFeedbackId");
    expect(text).toContain(
      "if none arrive within a reasonable window, the reviewer likely approved"
    );
  });

  it("places the guidance block after a blank line separator", () => {
    const text = buildLaunchPersonaResponseText(persona, agentId, true);
    expect(text).toContain(`${base}\n\nReview was launched with recheck`);
  });
});
