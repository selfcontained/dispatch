#!/usr/bin/env node

/**
 * CI gate: fails when a pull request description contains a Claude Code
 * session link. Run by `.github/workflows/pr-body-check.yml`.
 *
 * The body arrives through `PR_BODY` rather than an argument because it is
 * untrusted, attacker-controllable input on a public repo — interpolating it
 * into a shell command line would be a script-injection hole.
 *
 * Only the description is inspected. This file, its tests, and the workflow
 * all name the banned path in source, and none of that is in scope for the
 * check — which is what keeps the gate green on the PR that introduces it.
 */

import {
  findSessionLinks,
  formatSessionLinkFailure,
} from "../apps/server/src/shared/github/pr-body-lint.js";

const body = process.env.PR_BODY;
if (body === undefined) {
  console.error(
    "PR_BODY is not set. This script expects the pull request description in the PR_BODY environment variable."
  );
  process.exit(2);
}

const matches = findSessionLinks(body);
if (matches.length === 0) {
  console.log("PR description is clean: no Claude Code session links.");
  process.exit(0);
}

console.error(formatSessionLinkFailure(matches));
process.exit(1);
