#!/usr/bin/env node
// Decides how much of CI a pull request needs. Prints `scope=docs` only when
// every change is a plain edit or addition to reviewed, non-executable prose;
// anything else — or any doubt — is `scope=full`.
//
// The diff is the PR merge commit against its first parent (the base branch
// tip GitHub merged onto), so it is exactly what merging would introduce. That
// avoids merge-base guesses and stale `pull_request.base.sha` values, and with
// `--no-renames` a rename shows up as a deletion plus an addition, so moving
// code into `docs/` still deletes a non-docs path.

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Nothing builds, tests, packages, loads at runtime, or publishes these.
// Prose that the product or release reads stays out: `.agents/personas/` and
// `plugins/` are loaded by the server, `release-notes/` feeds releases, and
// the root README ships in the release package.
const ROOT_PROSE = new Set(["AGENTS.md", "CLAUDE.md", "TODO.md"]);

export function isDocsPath(path) {
  if (ROOT_PROSE.has(path)) return true;
  return (
    /^docs\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md$/.test(path) &&
    !path.split("/").includes("..")
  );
}

// Parses `git diff --raw -z --no-renames` output into change entries.
export function parseRawDiff(raw) {
  const fields = raw.split("\0");
  const entries = [];
  for (let i = 0; i < fields.length; i++) {
    const meta = fields[i];
    if (meta === "") continue;
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(
      meta
    );
    if (!match)
      throw new Error(`unexpected diff record: ${JSON.stringify(meta)}`);
    const path = fields[++i];
    if (path === undefined || path === "")
      throw new Error("diff record without a path");
    entries.push({
      oldMode: match[1],
      newMode: match[2],
      status: match[3],
      path,
    });
  }
  return entries;
}

// Returns { scope, reasons } for parsed diff entries.
export function classify(entries) {
  if (entries.length === 0) return { scope: "full", reasons: ["empty diff"] };
  const reasons = [];
  for (const { status, oldMode, newMode, path } of entries) {
    if (!isDocsPath(path))
      reasons.push(`${path}: not an allowlisted docs path`);
    else if (status !== "M" && status !== "A")
      reasons.push(
        `${path}: status ${status} (only edits and additions qualify)`
      );
    else if (newMode !== "100644" || (status === "M" && oldMode !== "100644"))
      reasons.push(
        `${path}: mode ${oldMode} -> ${newMode} (only regular, non-executable files qualify)`
      );
  }
  return reasons.length === 0
    ? { scope: "docs", reasons: [] }
    : { scope: "full", reasons };
}

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

// Classifies the checked-out PR merge commit. Any failure means full CI.
export function scopeForCheckout(expectedHeadSha) {
  try {
    const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"])
      .trim()
      .split(" ")
      .slice(1);
    if (parents.length !== 2)
      return {
        scope: "full",
        reasons: [
          `HEAD has ${parents.length} parent(s), expected a PR merge commit`,
        ],
      };
    if (!expectedHeadSha || parents[1] !== expectedHeadSha)
      return {
        scope: "full",
        reasons: [
          `merge commit's PR parent ${parents[1]} is not the PR head ${expectedHeadSha || "(unset)"}`,
        ],
      };
    return classify(
      parseRawDiff(
        git([
          "diff",
          "--raw",
          "-z",
          "--no-renames",
          "--no-ext-diff",
          "HEAD^1",
          "HEAD",
        ])
      )
    );
  } catch (error) {
    return {
      scope: "full",
      reasons: [`could not classify the diff: ${error.message}`],
    };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { scope, reasons } = scopeForCheckout(process.env.PR_HEAD_SHA);
  console.log(`CI scope: ${scope}`);
  for (const reason of reasons.slice(0, 50)) console.log(`  - ${reason}`);
  if (reasons.length > 50) console.log(`  … and ${reasons.length - 50} more`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `scope=${scope}\n`);
}
