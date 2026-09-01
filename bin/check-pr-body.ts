#!/usr/bin/env node

/**
 * CI gate: fails when a pull request title or description contains a Claude
 * Code session link. Run by `.github/workflows/pr-session-link-check.yml`,
 * which executes the copy of this file on the base branch — never the one in
 * the PR under test.
 *
 * Title and body arrive through the environment rather than as arguments
 * because they are untrusted, attacker-controllable input on a public repo;
 * interpolating either into a shell command line would be an injection hole.
 *
 * Output is redacted. Actions logs on a public repo are themselves a durable
 * public surface, so printing the offending URL to complain about the
 * offending URL would republish the identifier somewhere editing the PR
 * cannot reach. Line numbers survive, which is what the fix needs.
 */

import {
  findSessionLinks,
  formatSessionLinkFailure,
} from "../apps/server/src/shared/github/pr-body-lint.js";

function read(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    // Exit 2, distinct from a real finding: a misconfigured workflow must fail
    // loudly rather than report a clean bill of health it never checked.
    console.error(
      `${name} is not set. This script expects the pull request title in PR_TITLE and its description in PR_BODY.`
    );
    process.exit(2);
  }
  return value;
}

const title = read("PR_TITLE");
const body = read("PR_BODY");

const failures = [
  { subject: "The PR title", matches: findSessionLinks(title) },
  { subject: "The PR description", matches: findSessionLinks(body) },
].filter((failure) => failure.matches.length > 0);

if (failures.length === 0) {
  console.log(
    "PR title and description are clean: no Claude Code session links."
  );
  process.exit(0);
}

for (const failure of failures) {
  console.error(
    formatSessionLinkFailure(failure.matches, {
      subject: failure.subject,
      redact: true,
    })
  );
  console.error("");
}
process.exit(1);
