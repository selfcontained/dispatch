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

  it("appends round-trip guidance when allowRecheck is true", () => {
    const text = buildLaunchPersonaResponseText(persona, agentId, true);

    expect(text.startsWith(base)).toBe(true);
    expect(text).toContain("Review was launched with recheck enabled");
    expect(text).toContain("dispatch_get_feedback");
    expect(text).toContain("dispatch_resolve_feedback");
    expect(text).toContain("dispatch_submit_resolution");
    expect(text).toContain("respondsToFeedbackId");
  });

  it("tells the parent not to emit a terminal event yet (stay alive)", () => {
    const text = buildLaunchPersonaResponseText(persona, agentId, true);
    expect(text).toContain("do not emit a terminal dispatch_event yet");
  });

  it("references the specific reviewer agent id in the guidance", () => {
    const text = buildLaunchPersonaResponseText(persona, agentId, true);
    expect(text).toContain(`personaAgentId="${agentId}"`);
  });

  it("describes waiting in agent-runtime-neutral terms (no Claude-specific tool names)", () => {
    const text = buildLaunchPersonaResponseText(persona, agentId, true);
    expect(text).not.toContain("ScheduleWakeup");
    expect(text).toMatch(/keep this turn alive/i);
  });

  it("does not instruct the parent to call any await/poll tool", () => {
    // Round-trip transitions are now pushed via terminal injection, not
    // surfaced through a polling MCP tool.
    const text = buildLaunchPersonaResponseText(persona, agentId, true);
    expect(text).not.toContain("dispatch_await_review");
    expect(text).not.toContain("dispatch_await_recheck");
    expect(text).not.toMatch(/pollAgainInSeconds/i);
  });

  it("explains that the next-round signal arrives via terminal injection", () => {
    const text = buildLaunchPersonaResponseText(persona, agentId, true);
    expect(text).toMatch(/inject .* prompt/i);
    expect(text).toMatch(/this terminal/i);
  });

  it("tells the parent to commit fixes before submitting resolution", () => {
    const text = buildLaunchPersonaResponseText(persona, agentId, true);
    expect(text).toContain(
      "Commit your fixes before submitting the resolution"
    );
    expect(text).toContain("current HEAD");
  });

  it("places the guidance block after a blank line separator", () => {
    const text = buildLaunchPersonaResponseText(persona, agentId, true);
    expect(text).toContain(`${base}\n\nReview was launched with recheck`);
  });
});
