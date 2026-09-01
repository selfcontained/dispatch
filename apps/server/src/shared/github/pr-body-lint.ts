/**
 * Detects Claude Code session links in text destined for a public surface.
 *
 * The Claude Code CLI's own system prompt instructs agents to end PR bodies
 * and commit messages with a link to the originating session. Nothing in
 * Dispatch adds it, and nothing in Dispatch can stop the CLI from suggesting
 * it — so the controls are `create_pr`, which refuses to open a PR carrying
 * one, and the `pr-session-link-check` workflow, which refuses to let one
 * merge.
 *
 * Scope is the session link only. The `🤖 Generated with [Claude Code]`
 * attribution line and the `Co-Authored-By:` trailer are deliberately left
 * alone — they carry no identifier.
 */

/**
 * Deliberately looser than the URLs actually emitted: no scheme required, no
 * trailing `session_<id>` required. A gate that only recognizes the exact
 * shape today's CLI produces stops working the first time that shape changes,
 * and there is no legitimate reason to name this path in a PR.
 */
const SESSION_LINK = /claude\.ai\/code\/session/i;

/** The whole URL-ish token, for redaction. Global: a line can hold several. */
const SESSION_LINK_TOKEN = /\S*claude\.ai\/code\/session\S*/gi;

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
 * The failure message, naming every offending line so the fix is "delete
 * these lines" with no interpretation required.
 *
 * `redact` masks the URL itself while keeping the line number and the
 * surrounding text. CI must pass it: GitHub Actions logs on a public repo are
 * themselves a public, durable surface, so echoing the session URL there to
 * complain about the session URL would republish the identifier in a place
 * that editing the PR description cannot reach. The `create_pr` caller runs
 * locally against Brad's own terminal and keeps the full line.
 */
export function formatSessionLinkFailure(
  matches: SessionLinkMatch[],
  { subject, redact }: { subject: string; redact: boolean }
): string {
  const lines = matches
    .map((match) => {
      const shown = redact
        ? match.line.replace(SESSION_LINK_TOKEN, "[session link redacted]")
        : match.line;
      return `  line ${match.lineNumber}: ${shown}`;
    })
    .join("\n");

  return [
    `${subject} ${matches.length === 1 ? "contains a Claude Code session link" : "contains Claude Code session links"}.`,
    "",
    "Offending lines — delete the session link from each:",
    lines,
    "",
    "This repository is public, so a session link publishes an internal session",
    "identifier to anyone who can read the PR. Keep the rest of the text as-is —",
    'the "🤖 Generated with [Claude Code]" line and the Co-Authored-By trailer',
    "are fine and should stay.",
  ].join("\n");
}
