import { describe, it, expect } from "vitest";

import { buildLaunchPersonaResponseText } from "../src/shared/mcp/persona-interaction-tools.js";

describe("buildLaunchPersonaResponseText", () => {
  const persona = "backend-security-review";
  const agentId = "agt_test123";
  const base = `Launched persona "${persona}" as review agent ${agentId}.`;

  it("starts with the launch confirmation", () => {
    const text = buildLaunchPersonaResponseText(persona, agentId);
    expect(text.startsWith(base)).toBe(true);
  });

  it("includes unified review guidance", () => {
    const text = buildLaunchPersonaResponseText(persona, agentId);
    expect(text).toContain("dispatch_review_submit");
    expect(text).toContain("dispatch_review_list_feedback");
    expect(text).toContain("dispatch_review_resolve");
    expect(text).toMatch(/asking the reviewer to verify/i);
  });

  it("explains that clean approvals are tracked", () => {
    const text = buildLaunchPersonaResponseText(persona, agentId);
    expect(text).toContain("clean approval");
    expect(text).toContain("empty feedback array");
  });

  it("references the specific reviewer agent id in the guidance", () => {
    const text = buildLaunchPersonaResponseText(persona, agentId);
    expect(text).toContain(agentId);
  });

  it("uses no Claude-specific tool names", () => {
    const text = buildLaunchPersonaResponseText(persona, agentId);
    expect(text).not.toContain("ScheduleWakeup");
  });

  it("does not instruct the parent to call any await/poll tool", () => {
    const text = buildLaunchPersonaResponseText(persona, agentId);
    expect(text).not.toContain("dispatch_await_review");
    expect(text).not.toContain("dispatch_await_recheck");
    expect(text).not.toMatch(/pollAgainInSeconds/i);
    expect(text).toMatch(/do not poll, sleep/i);
    expect(text).toMatch(/end this turn/i);
  });

  it("keeps persona feedback open until the reviewer verifies it", () => {
    const text = buildLaunchPersonaResponseText(persona, agentId);
    expect(text).toMatch(/do not call dispatch_review_resolve/i);
    expect(text).toMatch(/reviewer will re-inspect/i);
  });

  it("explains that the review signal arrives via structured injection", () => {
    const text = buildLaunchPersonaResponseText(persona, agentId);
    expect(text).toMatch(/inject .* structured/i);
    expect(text).toContain("REVIEW SUBMITTED");
  });

  it("does not mention the legacy resolution lifecycle", () => {
    const text = buildLaunchPersonaResponseText(persona, agentId);
    expect(text).not.toContain("dispatch_submit_resolution");
    expect(text).not.toContain("round 2");
  });

  it("places the guidance block after a blank line separator", () => {
    const text = buildLaunchPersonaResponseText(persona, agentId);
    expect(text).toContain(`${base}\n\nThe reviewer will inspect`);
  });
});
