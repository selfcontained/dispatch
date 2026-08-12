import { describe, expect, it } from "vitest";

import { renderTemplateLaunchPrompt } from "../src/templates/launch-prompt.js";

describe("renderTemplateLaunchPrompt", () => {
  it("fills a lone variable with the caller's prompt", () => {
    const result = renderTemplateLaunchPrompt(
      "Build this idea:\n\n{{D:Idea|required|textarea}}\n\nGo.",
      "Fix the launch bug"
    );

    expect(result.prompt).toBe("Build this idea:\n\nFix the launch bug\n\nGo.");
    expect(result.unfilled).toEqual([]);
  });

  it("appends the caller's prompt when the template has no variables", () => {
    const result = renderTemplateLaunchPrompt(
      "Run the nightly checks.",
      "Skip the slow suite"
    );

    expect(result.prompt).toBe(
      "Run the nightly checks.\n\nSkip the slow suite"
    );
  });

  it("fills variables from args and appends the caller's prompt", () => {
    const result = renderTemplateLaunchPrompt(
      "Review {{D:Target}} for {{D:Concern|required}}.",
      "be thorough",
      { target: "the diff", concern: "security" }
    );

    expect(result.prompt).toBe("Review the diff for security.\n\nbe thorough");
    expect(result.unfilled).toEqual([]);
  });

  it("lets the caller's prompt fill the one variable args left unset", () => {
    const result = renderTemplateLaunchPrompt(
      "Review {{D:Target}} for {{D:Concern|required}}.",
      "security",
      { Target: "the diff" }
    );

    expect(result.prompt).toBe("Review the diff for security.");
    expect(result.unfilled).toEqual([]);
  });

  it("renders unset variables empty and reports them", () => {
    const result = renderTemplateLaunchPrompt(
      "Review {{D:Target|required}} for {{D:Concern|required}}.",
      "have a look"
    );

    expect(result.prompt).toBe("Review  for .\n\nhave a look");
    expect(result.prompt).not.toContain("{{D:");
    expect(result.unfilled).toEqual(["Target", "Concern"]);
  });

  it("does not treat a variable named after an Object member as supplied", () => {
    const result = renderTemplateLaunchPrompt(
      "Call {{D:toString}} then {{D:constructor}}.",
      "go"
    );

    expect(result.prompt).toBe("Call  then .\n\ngo");
    expect(result.unfilled).toEqual(["toString", "constructor"]);
  });

  it("keeps the template prompt intact when the caller sends no prompt", () => {
    const result = renderTemplateLaunchPrompt("Run the nightly checks.", "   ");

    expect(result.prompt).toBe("Run the nightly checks.");
  });
});
