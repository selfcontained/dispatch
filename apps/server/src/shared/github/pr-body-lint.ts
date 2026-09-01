/**
 * Detects Claude Code session links in text destined for a public surface.
 *
 * The Claude Code CLI's own system prompt instructs agents to end PR bodies
 * and commit messages with a link to the originating session. Nothing in
 * Dispatch adds it, and nothing in Dispatch can stop the CLI from suggesting
 * it — so the only reliable controls are the ones that reject the text before
 * it is published: `create_pr` (fast feedback for Dispatch agents) and the
 * `pr-body-check` workflow (the hard gate, which also catches PRs opened by
 * hand or by non-Dispatch tooling).
 *
 * Scope is the session link only. The `🤖 Generated with [Claude Code]`
 * attribution line and the `Co-Authored-By:` trailer are deliberately left
 * alone — they carry no identifier.
 */

/**
 * Deliberately looser than the URLs actually emitted: no scheme required, no
 * trailing `session_<id>` required. A gate that only recognizes the exact
 * shape today's CLI produces stops working the first time that shape changes,
 * and there is no legitimate reason to name this path in a PR description.
 */
const SESSION_LINK = /claude\.ai\/code\/session/i;

export type SessionLinkMatch = {
  /** 1-based, so it lines up with what an editor shows. */
  lineNumber: number;
  line: string;
};

export function findSessionLinks(text: string): SessionLinkMatch[] {
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!SESSION_LINK.test(line)) {
      return [];
    }
    return [{ lineNumber: index + 1, line: line.trim() }];
  });
}

/**
 * Builds the message both gates show. It names every offending line verbatim
 * so the fix is "delete these lines", with no interpretation required.
 */
export function formatSessionLinkFailure(
  matches: SessionLinkMatch[],
  subject = "The PR description"
): string {
  const lines = matches
    .map((match) => `  line ${match.lineNumber}: ${match.line}`)
    .join("\n");

  return [
    `${subject} contains ${matches.length === 1 ? "a Claude Code session link" : "Claude Code session links"}.`,
    "",
    "Delete exactly these lines:",
    lines,
    "",
    "This repository is public, so a session link publishes an internal session",
    "identifier to anyone who can read the PR. Keep the rest of the text as-is —",
    'the "🤖 Generated with [Claude Code]" line and the Co-Authored-By trailer',
    "are fine and should stay.",
  ].join("\n");
}
