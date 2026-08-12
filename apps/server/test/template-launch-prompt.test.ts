import { describe, expect, it } from "vitest";

import {
  renderTemplatePrompt,
  renderTemplatePromptFromFreeText,
  type RenderableTemplate,
} from "../src/templates/launch-prompt.js";

function template(
  prompt: string,
  overrides: Partial<RenderableTemplate> = {}
): RenderableTemplate {
  return { id: "tmpl_123", selfImprove: false, prompt, ...overrides };
}

describe("renderTemplatePrompt", () => {
  it("substitutes args", () => {
    expect(
      renderTemplatePrompt(template("Review {{D:Target}}."), {
        target: "the diff",
      })
    ).toBe("Review the diff.");
  });

  it("appends the self-improvement footer when the template opts in", () => {
    const result = renderTemplatePrompt(
      template("Do the thing.", { selfImprove: true }),
      {}
    );

    expect(result).toContain("Do the thing.");
    expect(result).toContain("Self-improvement:");
    expect(result).toContain('templateId "tmpl_123"');
  });

  it("puts an appendix before the footer, not after it", () => {
    const result = renderTemplatePrompt(
      template("Do the thing.", { selfImprove: true }),
      {},
      "extra instructions"
    );

    expect(result.indexOf("extra instructions")).toBeLessThan(
      result.indexOf("Self-improvement:")
    );
  });
});

describe("renderTemplatePromptFromFreeText", () => {
  it("fills a lone arg with the caller's prompt", () => {
    const result = renderTemplatePromptFromFreeText(
      template("Build this idea:\n\n{{D:Idea|required|textarea}}\n\nGo."),
      "Fix the launch bug"
    );

    expect(result.prompt).toBe("Build this idea:\n\nFix the launch bug\n\nGo.");
    expect(result.unfilled).toEqual([]);
  });

  it("appends the caller's prompt when the template has no args", () => {
    const result = renderTemplatePromptFromFreeText(
      template("Run the nightly checks."),
      "Skip the slow suite"
    );

    expect(result.prompt).toBe(
      "Run the nightly checks.\n\nSkip the slow suite"
    );
  });

  it("fills args from callerArgs and appends the caller's prompt", () => {
    const result = renderTemplatePromptFromFreeText(
      template("Review {{D:Target}} for {{D:Concern|required}}."),
      "be thorough",
      { target: "the diff", concern: "security" }
    );

    expect(result.prompt).toBe("Review the diff for security.\n\nbe thorough");
    expect(result.unfilled).toEqual([]);
  });

  it("lets the caller's prompt fill the one arg callerArgs left unset", () => {
    const result = renderTemplatePromptFromFreeText(
      template("Review {{D:Target}} for {{D:Concern|required}}."),
      "security",
      { Target: "the diff" }
    );

    expect(result.prompt).toBe("Review the diff for security.");
    expect(result.unfilled).toEqual([]);
  });

  it("renders unset args empty and reports them", () => {
    const result = renderTemplatePromptFromFreeText(
      template("Review {{D:Target|required}} for {{D:Concern|required}}."),
      "have a look"
    );

    expect(result.prompt).toBe("Review  for .\n\nhave a look");
    expect(result.prompt).not.toContain("{{D:");
    expect(result.unfilled).toEqual(["Target", "Concern"]);
  });

  it("does not treat an arg named after an Object member as supplied", () => {
    const result = renderTemplatePromptFromFreeText(
      template("Call {{D:toString}} then {{D:constructor}}."),
      "go"
    );

    expect(result.prompt).toBe("Call  then .\n\ngo");
    expect(result.unfilled).toEqual(["toString", "constructor"]);
  });

  it("treats a repeated arg as one, so the caller's prompt still fills it", () => {
    const result = renderTemplatePromptFromFreeText(
      template("{{D:Idea}} — restated: {{D:Idea|required}}"),
      "ship it"
    );

    expect(result.prompt).toBe("ship it — restated: ship it");
    expect(result.unfilled).toEqual([]);
  });

  it("reports a key that matches no arg, and keeps free text out of its slot", () => {
    const result = renderTemplatePromptFromFreeText(
      template("Review {{D:PR URL|required}}."),
      "review it please",
      { prUrl: "https://example.com/pr/1" }
    );

    expect(result.unknown).toEqual(["prUrl"]);
    expect(result.unfilled).toEqual(["PR URL"]);
    expect(result.prompt).toBe("Review .\n\nreview it please");
  });

  it("fills every occurrence of an arg written in more than one case", () => {
    const result = renderTemplatePromptFromFreeText(
      template("Repo: {{D:Repo}}\nAgain: {{D:repo}}"),
      "",
      { Repo: "dispatch" }
    );

    expect(result.prompt).toBe("Repo: dispatch\nAgain: dispatch");
    expect(result.unfilled).toEqual([]);
    expect(result.unknown).toEqual([]);
  });

  it("does not substitute arg syntax that came from a caller's value", () => {
    const result = renderTemplatePromptFromFreeText(
      template("Review {{D:Target}} for {{D:Concern}}."),
      "",
      { Target: "{{D:Concern}}", Concern: "security" }
    );

    expect(result.prompt).toBe("Review {{D:Concern}} for security.");
  });

  it("keeps the template prompt intact when the caller sends no prompt", () => {
    const result = renderTemplatePromptFromFreeText(
      template("Run the nightly checks."),
      "   "
    );

    expect(result.prompt).toBe("Run the nightly checks.");
  });
});
