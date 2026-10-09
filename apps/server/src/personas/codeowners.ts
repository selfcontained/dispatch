import { access, readFile } from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";

import type { CommandRunner } from "../shared/lib/run-command.js";
import { validatePersonaSlug } from "./authoring.js";
import { LEGACY_OWNERS_PATH, OWNERS_PATH } from "./paths.js";

// Deliberately small glob language: repo-relative paths, *, **, and ?.
// All matching rules contribute owners; there is no last-rule-wins behavior.
const patternSchema = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value
        .split("/")
        .some(
          (segment) => segment === ".." || segment === "." || segment === ""
        ) &&
      !/[\[\]{}!\r\n]/u.test(value),
    "Use repo-relative patterns with only *, **, and ? wildcards."
  );
const slugSchema = z.string().superRefine((slug, ctx) => {
  try {
    validatePersonaSlug(slug);
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid persona slug." });
  }
});
const configSchema = z
  .object({
    version: z.literal(1),
    rules: z.array(
      z
        .object({
          paths: z.array(patternSchema).min(1),
          personas: z.array(slugSchema).min(1),
          exclude: z.array(patternSchema).optional(),
        })
        .strict()
    ),
    fallback: z.array(slugSchema).optional(),
  })
  .strict();
export type CodeownersConfig = z.infer<typeof configSchema>;
export type OwnerReviewPlan = {
  baseRef: string;
  changedFiles: string[];
  owners: Array<{ persona: string; files: string[] }>;
  uncoveredFiles: string[];
};
export type OwnerReviewResult = OwnerReviewPlan & {
  launched: Array<{
    persona: string;
    agentId: string;
    files: string[];
    warnings?: string[];
  }>;
  failures: Array<{ persona: string; error: string; files: string[] }>;
};

/** The owners map in use: `.agents/owners.json`, else the legacy location. */
async function findOwnersPath(root: string): Promise<string | null> {
  for (const candidate of [OWNERS_PATH, LEGACY_OWNERS_PATH]) {
    try {
      await access(path.join(root, candidate));
      return candidate;
    } catch {
      // Try the next location.
    }
  }
  return null;
}

/** Whether the checkout has an ownership map at all; validity is checked at launch. */
export async function hasCodeowners(root: string): Promise<boolean> {
  return (await findOwnersPath(root)) !== null;
}

export async function loadCodeowners(root: string): Promise<CodeownersConfig> {
  const ownersPath = await findOwnersPath(root);
  if (!ownersPath) {
    throw new Error(
      `No ${OWNERS_PATH} found in this workspace. Add ownership rules before launching owner reviews.`
    );
  }
  const content = await readFile(path.join(root, ownersPath), "utf8");
  try {
    return configSchema.parse(JSON.parse(content));
  } catch (error) {
    throw new Error(
      `Invalid ${ownersPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function matchesOwnerPattern(file: string, pattern: string): boolean {
  let expression = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        expression += "(?:.*/)?";
        i++;
      } else expression += ".*";
    } else if (char === "*") expression += "[^/]*";
    else if (char === "?") expression += "[^/]";
    else expression += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(expression + "$", "u").test(file);
}

export function resolveCodeowners(
  config: CodeownersConfig,
  files: string[],
  baseRef: string
): OwnerReviewPlan {
  const changedFiles = [...new Set(files)].sort();
  const owners = new Map<string, Set<string>>();
  const uncoveredFiles: string[] = [];
  const add = (persona: string, file: string) => {
    if (!owners.has(persona)) owners.set(persona, new Set());
    owners.get(persona)!.add(file);
  };
  for (const file of changedFiles) {
    let covered = false;
    for (const rule of config.rules) {
      if (
        rule.paths.some((pattern) => matchesOwnerPattern(file, pattern)) &&
        !rule.exclude?.some((pattern) => matchesOwnerPattern(file, pattern))
      ) {
        covered = true;
        for (const persona of rule.personas) add(persona, file);
      }
    }
    if (!covered) {
      uncoveredFiles.push(file);
      for (const persona of config.fallback ?? []) add(persona, file);
    }
  }
  return {
    baseRef,
    changedFiles,
    uncoveredFiles,
    owners: [...owners].map(([persona, paths]) => ({
      persona,
      files: [...paths],
    })),
  };
}

export async function collectOwnerReviewFiles(
  cwd: string,
  baseRef: string,
  run: CommandRunner
): Promise<string[]> {
  // --no-renames represents a rename as deletion + addition, so both owners
  // are selected. NUL delimiters preserve whitespace and unusual filenames.
  const results = await Promise.all([
    run(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", `${baseRef}...HEAD`, "--"],
      { cwd, trimOutput: false }
    ),
    // Index and working-tree edits can cancel in diff HEAD. Collect both.
    run(
      "git",
      ["diff", "--cached", "--name-only", "--no-renames", "-z", "HEAD", "--"],
      { cwd, trimOutput: false }
    ),
    run("git", ["diff", "--name-only", "--no-renames", "-z", "--"], {
      cwd,
      trimOutput: false,
    }),
    run("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd,
      trimOutput: false,
    }),
  ]);
  return [
    ...new Set(
      results.flatMap((result) => result.stdout.split("\0").filter(Boolean))
    ),
  ].sort();
}

export async function launchOwnerReviewPlan(
  plan: OwnerReviewPlan,
  context: string,
  launch: (
    persona: string,
    context: string
  ) => Promise<{ agentId: string; warnings?: string[] }>
): Promise<OwnerReviewResult> {
  const result: OwnerReviewResult = { ...plan, launched: [], failures: [] };
  // Launch sequentially to preserve normal lifecycle ordering. Review agents
  // run concurrently once started. A failure must not hide successful launches.
  for (const owner of plan.owners) {
    try {
      // The launch transport handles overflow losslessly, including ownership scope.
      const scope = owner.files.map((file) => JSON.stringify(file)).join("\n");
      const briefing = `## Code ownership scope\nYou were selected as ${owner.persona}. The review base is ${plan.baseRef}. Paths are repository-relative; inspect them from the repository root. Review these changes and their effects on your subsystem. Read related code and changed contracts as needed; only report defects introduced or worsened by this change.\n\nMatched changed paths:\n${scope}\n\n## Change briefing\n${context}`;
      const launched = await launch(owner.persona, briefing);
      result.launched.push({
        ...owner,
        agentId: launched.agentId,
        ...(launched.warnings ? { warnings: launched.warnings } : {}),
      });
    } catch (error) {
      result.failures.push({
        ...owner,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
