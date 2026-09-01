import { describe, expect, it } from "vitest";

import {
  findSessionLinks,
  formatSessionLinkFailure,
} from "../src/shared/github/pr-body-lint.js";

// The fixtures below embed the banned URL on purpose. Both gates read only the
// PR description, never repository files, so a literal here cannot make the
// gate fail on the change that introduces it.
const SESSION_URL = "https://claude.ai/code/session_01Wb3tshqgQQxvhFSNFtEext";

const REAL_WORLD_FOOTER = [
  "Fixes the thing.",
  "",
  "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  "",
  SESSION_URL,
  "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
  `Claude-Session: ${SESSION_URL}`,
].join("\n");

describe("findSessionLinks", () => {
  it("finds both the bare URL and the Claude-Session trailer", () => {
    expect(findSessionLinks(REAL_WORLD_FOOTER)).toEqual([
      { lineNumber: 5, line: SESSION_URL },
      { lineNumber: 7, line: `Claude-Session: ${SESSION_URL}` },
    ]);
  });

  it("leaves the attribution line and Co-Authored-By trailer alone", () => {
    const kept = [
      "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
      "Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>",
    ].join("\n");

    expect(findSessionLinks(kept)).toEqual([]);
  });

  it("returns nothing for an empty body", () => {
    expect(findSessionLinks("")).toEqual([]);
  });

  it("matches regardless of scheme, case, or surrounding markdown", () => {
    const variants = [
      "See CLAUDE.AI/CODE/SESSION_01abc for context.",
      "[session](http://claude.ai/code/session_01abc)",
      "> Claude-Session: claude.ai/code/session_01abc",
    ].join("\n");

    expect(findSessionLinks(variants)).toHaveLength(3);
  });

  it("normalizes CRLF bodies, which is what the GitHub API returns", () => {
    const body = ["intro", `Claude-Session: ${SESSION_URL}`, "outro"].join(
      "\r\n"
    );

    expect(findSessionLinks(body)).toEqual([
      { lineNumber: 2, line: `Claude-Session: ${SESSION_URL}` },
    ]);
  });

  it("does not match other claude.ai paths", () => {
    expect(findSessionLinks("https://claude.ai/code/artifacts/abc")).toEqual(
      []
    );
  });
});

describe("formatSessionLinkFailure", () => {
  it("names every offending line so the fix needs no interpretation", () => {
    const message = formatSessionLinkFailure(
      findSessionLinks(REAL_WORLD_FOOTER)
    );

    expect(message).toContain(`line 5: ${SESSION_URL}`);
    expect(message).toContain(`line 7: Claude-Session: ${SESSION_URL}`);
    expect(message).toContain("Delete exactly these lines:");
  });

  it("takes a subject so callers other than CI read correctly", () => {
    const message = formatSessionLinkFailure(
      findSessionLinks(SESSION_URL),
      "The body passed to create_pr"
    );

    expect(message).toContain(
      "The body passed to create_pr contains a Claude Code session link."
    );
  });
});
