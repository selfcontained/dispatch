import { describe, it, expect } from "vitest";

import {
  agentIdFromSessionName,
  shouldSuggestSessionRename,
  toSessionName,
} from "../src/agents/tmux/session-name.js";

describe("agentIdFromSessionName", () => {
  it("extracts the agent ID from the canonical 12-hex pattern", () => {
    expect(agentIdFromSessionName("dispatch_agt_abc123def456_my-task")).toBe(
      "agt_abc123def456"
    );
  });

  it("works with the dev prefix variant", () => {
    expect(
      agentIdFromSessionName("dispatch_dev_agt_abc123def456_my-task")
    ).toBe("agt_abc123def456");
  });

  it("works when there is no slug suffix", () => {
    expect(agentIdFromSessionName("dispatch_agt_abc123def456")).toBe(
      "agt_abc123def456"
    );
  });

  it("falls back to stripping the leading <prefix>_ when no canonical ID is present (legacy sessions)", () => {
    // Legacy session names didn't include the `agt_` discriminator. The
    // fallback strips just the prefix segment so the rest is treated as
    // the agent ID.
    expect(agentIdFromSessionName("dispatch_legacyagent")).toBe("legacyagent");
  });

  it("handles uppercase or non-hex IDs by falling through to the legacy path", () => {
    // The pattern requires lowercase hex specifically; everything else
    // takes the legacy fallback.
    expect(agentIdFromSessionName("dispatch_agt_ABCDEF123456")).toBe(
      "agt_ABCDEF123456"
    );
  });
});

describe("toSessionName", () => {
  it("returns <prefix>_<id> when no name is supplied", () => {
    expect(toSessionName("dispatch", "agt_abc123def456")).toBe(
      "dispatch_agt_abc123def456"
    );
  });

  it("appends a sanitized slug when a name is supplied", () => {
    expect(toSessionName("dispatch", "agt_abc123def456", "My Cool Task")).toBe(
      "dispatch_agt_abc123def456_my-cool-task"
    );
  });

  it("collapses runs of non-alphanumeric chars into a single hyphen", () => {
    expect(toSessionName("dispatch", "agt_x", "foo!!!bar @@ baz")).toBe(
      "dispatch_agt_x_foo-bar-baz"
    );
  });

  it("strips leading and trailing hyphens from the slug", () => {
    expect(toSessionName("dispatch", "agt_x", "---name---")).toBe(
      "dispatch_agt_x_name"
    );
  });

  it("truncates the slug to 30 chars (tmux name length is bounded)", () => {
    const longName = "a".repeat(50);
    const prefix = "dispatch";
    const id = "agt_abc123def456";
    const result = toSessionName(prefix, id, longName);
    // Strip the known `<prefix>_<id>_` head; what remains is the slug.
    const slug = result.slice(`${prefix}_${id}_`.length);
    expect(slug.length).toBeLessThanOrEqual(30);
    // The leading 30 'a's match — confirms truncation, not over-eager
    // sanitization removing valid chars.
    expect(slug).toBe("a".repeat(30));
  });

  it("respects the prefix argument (used to vary in dev mode)", () => {
    expect(toSessionName("dispatch_dev", "agt_x", "task")).toBe(
      "dispatch_dev_agt_x_task"
    );
  });

  it("falls through to the no-name shape when sanitization strips everything", () => {
    // `!!!` sanitizes to "", so the function collapses to `<prefix>_<id>`
    // rather than emitting a trailing-underscore shape that no other
    // branch produces.
    expect(toSessionName("dispatch", "agt_x", "!!!")).toBe("dispatch_agt_x");
  });
});

describe("shouldSuggestSessionRename", () => {
  const id = "agt_abc123def456";
  const placeholder = `agent-${id.slice(-6)}`;

  it("never suggests rename for persona agents", () => {
    expect(
      shouldSuggestSessionRename(placeholder, id, { persona: "code-review" })
    ).toBe(false);
  });

  it("suggests rename for a standard agent still on the placeholder name", () => {
    expect(shouldSuggestSessionRename(placeholder, id, {})).toBe(true);
  });

  it("does not suggest rename when the user has chosen a meaningful name", () => {
    expect(shouldSuggestSessionRename("my-feature", id, {})).toBe(false);
  });

  it("trims surrounding whitespace before checking the placeholder", () => {
    expect(shouldSuggestSessionRename(`  ${placeholder}  `, id, {})).toBe(true);
  });

  it("returns false for null/undefined names", () => {
    expect(shouldSuggestSessionRename(null, id, {})).toBe(false);
    expect(shouldSuggestSessionRename(undefined, id, {})).toBe(false);
  });

  it("for job runs, suggests rename only when name still matches job-...-<jobIdPrefix>", () => {
    const jobRunId = "run_jobid12345678";
    const placeholderJobName = `job-thing-${jobRunId.slice(0, 8)}`;
    expect(
      shouldSuggestSessionRename(placeholderJobName, id, { jobRunId })
    ).toBe(true);
  });

  it("for job runs, does not suggest rename for a renamed job", () => {
    const jobRunId = "run_jobid12345678";
    expect(shouldSuggestSessionRename("renamed-job", id, { jobRunId })).toBe(
      false
    );
  });

  it("suggests rename for template-launched agents regardless of name", () => {
    expect(
      shouldSuggestSessionRename("my_template", id, {
        templateId: "tmpl_abc123",
      })
    ).toBe(true);
  });

  it("does not suggest rename for template-launched persona agents", () => {
    expect(
      shouldSuggestSessionRename("my_template", id, {
        templateId: "tmpl_abc123",
        persona: "security-review",
      })
    ).toBe(false);
  });
});
