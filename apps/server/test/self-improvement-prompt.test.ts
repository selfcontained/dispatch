import { describe, expect, it } from "vitest";

import { buildSelfImprovementGuidance } from "../src/shared/self-improvement-prompt.js";

/**
 * This footer is the instruction an agent follows to rewrite its own saved
 * launch prompt, so the tool name and the identifying arguments in it are
 * load-bearing: name the wrong tool or the wrong key and a self-improving run
 * either does nothing or edits somebody else's configuration.
 *
 * Only the job branch is covered here. The template branch already reaches
 * three suites through its caller (template-launch-prompt, templates/service,
 * mcp-handlers), while jobs/service.ts assembles its prompt in a module-private
 * function, so nothing else in the repo asserts the update_job instruction.
 */
describe("buildSelfImprovementGuidance", () => {
  it("tells a job agent to call update_job with its own name and directory", () => {
    const guidance = buildSelfImprovementGuidance({
      kind: "job",
      name: "Test Enforcer",
      directory: "/Users/someone/dev/apps/dispatch",
    });

    expect(guidance).toContain(
      'use update_job with name "Test Enforcer" and directory "/Users/someone/dev/apps/dispatch".'
    );
    expect(guidance).toContain("done-when criteria, or recovery instructions");
    expect(guidance).not.toContain("update_template");
  });

  it("opens on its own line so it cannot run into the prompt it is appended to", () => {
    // renderTemplatePrompt concatenates this onto the end of the prompt with
    // no separator of its own, so the leading break has to come from here.
    const guidance = buildSelfImprovementGuidance({
      kind: "job",
      name: "Test Enforcer",
      directory: "/repo",
    });

    expect(guidance.startsWith("\nSelf-improvement:\n")).toBe(true);
  });
});
