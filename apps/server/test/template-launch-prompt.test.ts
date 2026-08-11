import { describe, expect, it } from "vitest";

import { renderTemplateLaunchPrompt } from "../src/templates/launch-prompt.js";

describe("renderTemplateLaunchPrompt", () => {
  it("substitutes the caller's prompt into a single placeholder", () => {
    const result = renderTemplateLaunchPrompt({
      templatePrompt: "Build this idea:\n\n{{D:Idea|required|textarea}}\n\nGo.",
      callerPrompt: "Fix the launch bug",
    });

    expect(result.prompt).toBe("Build this idea:\n\nFix the launch bug\n\nGo.");
    expect(result.filledFromPrompt).toBe("Idea");
    expect(result.appendedCallerPrompt).toBe(false);
    expect(result.unfilled).toEqual([]);
  });

  it("appends the caller's prompt when the template has no placeholders", () => {
    const result = renderTemplateLaunchPrompt({
      templatePrompt: "Run the nightly checks.",
      callerPrompt: "Skip the slow suite",
    });

    expect(result.prompt).toBe(
      "Run the nightly checks.\n\n## Additional instructions from the launching agent\n\nSkip the slow suite"
    );
    expect(result.filledFromPrompt).toBeNull();
    expect(result.appendedCallerPrompt).toBe(true);
  });

  it("fills multiple placeholders from args and reports none unfilled", () => {
    const result = renderTemplateLaunchPrompt({
      templatePrompt: "Review {{D:Target}} for {{D:Concern|required}}.",
      callerPrompt: "be thorough",
      args: { target: "the diff", concern: "security" },
    });

    expect(result.prompt).toBe(
      "Review the diff for security.\n\n## Additional instructions from the launching agent\n\nbe thorough"
    );
    expect(result.unfilled).toEqual([]);
    expect(result.filledFromPrompt).toBeNull();
  });

  it("fills the one remaining placeholder from the prompt when args cover the rest", () => {
    const result = renderTemplateLaunchPrompt({
      templatePrompt: "Review {{D:Target}} for {{D:Concern|required}}.",
      callerPrompt: "security",
      args: { Target: "the diff" },
    });

    expect(result.prompt).toBe("Review the diff for security.");
    expect(result.filledFromPrompt).toBe("Concern");
    expect(result.appendedCallerPrompt).toBe(false);
  });

  it("renders unfilled placeholders empty instead of failing or leaking syntax", () => {
    const result = renderTemplateLaunchPrompt({
      templatePrompt:
        "Review {{D:Target|required}} for {{D:Concern|required}}.",
      callerPrompt: "have a look",
    });

    expect(result.prompt).toContain("Review  for .");
    expect(result.prompt).not.toContain("{{D:");
    expect(result.unfilled).toEqual(["Target", "Concern"]);
    expect(result.appendedCallerPrompt).toBe(true);
  });

  it("keeps the template prompt intact when the caller sends no prompt", () => {
    const result = renderTemplateLaunchPrompt({
      templatePrompt: "Run the nightly checks.",
      callerPrompt: "   ",
    });

    expect(result.prompt).toBe("Run the nightly checks.");
    expect(result.appendedCallerPrompt).toBe(false);
  });
});
