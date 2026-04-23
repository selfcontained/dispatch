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
    expect(text).toContain("dispatch_await_review");
    expect(text).toContain("dispatch_get_feedback");
    expect(text).toContain("dispatch_resolve_feedback");
    expect(text).toContain("dispatch_submit_resolution");
    expect(text).toContain("respondsToFeedbackId");
  });

  it("embeds the launching persona's agent id in the dispatch_await_review instruction", () => {
    const text = buildLaunchPersonaResponseText(persona, agentId, true);
    expect(text).toContain(
      `dispatch_await_review with personaAgentId="${agentId}"`
    );
  });

  it("names the survival-kit sleep mechanism", () => {
    // Regression guard: the parent must be told how to survive across
    // turns, not just "poll." See CRU-133 dogfood (gpt-5.4 parent emitted
    // done after launch because the guidance didn't operationalise waiting).
    const text = buildLaunchPersonaResponseText(persona, agentId, true);
    expect(text).toContain("ScheduleWakeup");
    expect(text).toContain("do not emit a terminal dispatch_event yet");
  });

  it("watches review status via dispatch_await_review, not feedback items", () => {
    // Regression guard: polling dispatch_get_feedback for status misfires
    // on the first item that lands. See CRU-133 dogfood notes.
    const text = buildLaunchPersonaResponseText(persona, agentId, true);
    expect(text).toContain("Do not poll dispatch_get_feedback for status");
  });

  it("tells the parent to commit fixes before submitting resolution", () => {
    // Regression guard: dogfood surfaced a parent that submitted
    // resolution with uncommitted fixes — reviewer's round-2 diff was
    // empty and would re-flag the same issues.
    const text = buildLaunchPersonaResponseText(persona, agentId, true);
    expect(text).toContain(
      "Commit your fixes before submitting the resolution"
    );
    expect(text).toContain("current HEAD");
  });

  it("does not promise an end-of-poll verdict signal from dispatch_get_feedback", () => {
    // Regression guard: CRU-133 review (feedback #1113).
    const text = buildLaunchPersonaResponseText(persona, agentId, true);
    expect(text).not.toMatch(/verdict is complete/i);
    expect(text).not.toMatch(/poll dispatch_get_feedback for round-2 items/);
  });

  it("places the guidance block after a blank line separator", () => {
    const text = buildLaunchPersonaResponseText(persona, agentId, true);
    expect(text).toContain(`${base}\n\nReview was launched with recheck`);
  });
});
