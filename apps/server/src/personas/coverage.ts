import { execFileSync } from "node:child_process";

import { getBuiltInPersona } from "./built-in.js";
import { parseCodeowners, resolveCodeowners } from "./codeowners.js";
import { supportsPersonaType, toPersonaDefinition } from "./loader.js";
import { OWNERS_PATH, PERSONA_DIRS } from "./paths.js";

const HELP = `Update ${OWNERS_PATH} and the selected review personas. See docs/code-owner-reviews.md.`;
type Git = (args: string[]) => string;

/** Check only final-head paths; runtime review routing deliberately also includes removals. */
export function checkOwnerCoverage(input: {
  cwd: string;
  baseSha: string;
  headSha: string;
  git?: Git;
}): { changedFiles: string[]; owners: string[] } {
  const git: Git =
    input.git ??
    ((args) =>
      execFileSync("git", args, {
        cwd: input.cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }));
  const fail = (message: string): never => {
    throw new Error(`${message}\n${HELP}`);
  };
  const run = (args: string[], description: string) => {
    try {
      return git(args);
    } catch {
      // Git errors can contain arbitrary file contents; report only the operation.
      return fail(
        `Cannot ${description}; ownership coverage was not established.`
      );
    }
  };
  for (const [label, sha] of [
    ["base", input.baseSha],
    ["head", input.headSha],
  ]) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha ?? ""))
      fail(`A pinned PR ${label} SHA is required.`);
    run(["cat-file", "-e", `${sha}^{commit}`], `resolve PR ${label} commit`);
  }
  const comparison = `${input.baseSha}...${input.headSha}`;
  // No rename detection means destinations/copies are additions. Excluding D
  // removes rename sources and deletions, without parsing two-path records.
  const raw = run(
    [
      "diff",
      "--name-only",
      "--no-renames",
      "--no-ext-diff",
      "--diff-filter=ACMRT",
      "-z",
      comparison,
      "--",
    ],
    "compare the PR base and head (merge base required)"
  );
  if (raw && !raw.endsWith("\0")) fail("Invalid NUL-delimited Git diff.");
  const files = raw.split("\0").filter(Boolean);
  // Read metadata from the head tree, never from the merge checkout or worktree.
  const tree = run(
    ["ls-tree", "-r", "-z", "--full-tree", input.headSha],
    "read the PR head tree"
  );
  const entries = new Map<string, string>();
  for (const entry of tree.split("\0").filter(Boolean)) {
    const match = /^(\d{6}) (?:blob|commit) [a-f0-9]+\t([\s\S]+)$/.exec(entry);
    if (!match) fail("Invalid Git head tree record.");
    entries.set(match![2], match![1]);
  }
  const read = (file: string): string => {
    if (!/^100(?:644|755)$/.test(entries.get(file) ?? ""))
      fail(
        `Missing or non-regular PR head definition ${JSON.stringify(file)}.`
      );
    return run(
      ["show", `${input.headSha}:${file}`],
      `read ${JSON.stringify(file)} at PR head`
    );
  };
  let config;
  try {
    config = parseCodeowners(read(OWNERS_PATH));
  } catch {
    return fail(
      `Missing or invalid PR head ${OWNERS_PATH}; use version 1 ownership rules with valid patterns and persona slugs.`
    );
  }
  const plan = resolveCodeowners(
    { ...config, fallback: [] },
    files,
    comparison
  );
  const problems = plan.uncoveredFiles.map(
    (file) => `No explicit owner for ${JSON.stringify(file)}.`
  );
  for (const owner of plan.owners) {
    const file = PERSONA_DIRS.map((dir) => `${dir}/${owner.persona}.md`).find(
      (candidate) => entries.has(candidate)
    );
    try {
      const persona = file
        ? toPersonaDefinition(owner.persona, read(file))
        : getBuiltInPersona(owner.persona);
      if (
        !persona ||
        !supportsPersonaType(persona, "review") ||
        !persona.body.trim()
      )
        throw new Error("Invalid reviewer");
    } catch {
      problems.push(
        `Invalid review persona ${JSON.stringify(owner.persona)}${file ? ` at ${JSON.stringify(file)}` : " (definition missing at PR head)"} selected for ${owner.files.map((file) => JSON.stringify(file)).join(", ")}. Provide a review persona with non-empty instructions.`
      );
    }
  }
  if (problems.length) fail(problems.join("\n"));
  return {
    changedFiles: plan.changedFiles,
    owners: plan.owners.map((owner) => owner.persona),
  };
}
