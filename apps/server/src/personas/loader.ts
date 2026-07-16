import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { AgentType } from "../agents/types.js";
import { buildCursorDispatchToolGuidance } from "../shared/mcp/cursor-dispatch-guidance.js";
import type { ReviewDiffResult } from "./review-diff.js";

export type PersonaDefinition = {
  /** Filename without extension (used as persona ID) */
  slug: string;
  /** Display name from frontmatter */
  name: string;
  /** Short description from frontmatter */
  description: string;
  /** Feedback format hint (default: "findings") */
  feedbackFormat: string;
  /** Raw markdown body (after frontmatter) */
  body: string;
};

type PersonaFrontmatter = {
  name?: string;
  description?: string;
  feedbackFormat?: string;
};

const PERSONAS_DIR = ".dispatch/personas";
export const INLINE_DIFF_THRESHOLD_BYTES = 15 * 1024;

export function parseFrontmatter(content: string): {
  frontmatter: PersonaFrontmatter;
  body: string;
} {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }

  const endIndex = trimmed.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { frontmatter: {}, body: content };
  }

  const fmBlock = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 4).trim();

  const frontmatter: Record<string, string> = {};
  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) {
      frontmatter[key] = value;
    }
  }

  return { frontmatter: frontmatter as PersonaFrontmatter, body };
}

export async function loadPersonas(
  repoRoot: string
): Promise<PersonaDefinition[]> {
  const dir = path.join(repoRoot, PERSONAS_DIR);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const mdFiles = entries.filter((f) => f.endsWith(".md")).sort();
  const personas: PersonaDefinition[] = [];

  for (const file of mdFiles) {
    const content = await readFile(path.join(dir, file), "utf-8");
    const { frontmatter, body } = parseFrontmatter(content);
    const slug = file.replace(/\.md$/, "");

    personas.push({
      slug,
      name: frontmatter.name ?? slug,
      description: frontmatter.description ?? "",
      feedbackFormat: frontmatter.feedbackFormat ?? "findings",
      body,
    });
  }

  return personas;
}

export function mergePersonasWithWorktreePrecedence<
  T extends { slug: string },
>(input: { worktreePersonas: T[]; repoPersonas: T[] }): T[] {
  const worktreeSlugs = new Set(input.worktreePersonas.map((p) => p.slug));
  return [
    ...input.worktreePersonas,
    ...input.repoPersonas.filter((p) => !worktreeSlugs.has(p.slug)),
  ];
}

export async function loadPersonasFromRoots(input: {
  worktreeRoot?: string | null;
  repoRoot?: string | null;
}): Promise<PersonaDefinition[]> {
  const worktreeRoot = input.worktreeRoot ?? null;
  const repoRoot = input.repoRoot ?? null;

  const worktreePersonas = worktreeRoot ? await loadPersonas(worktreeRoot) : [];
  const repoPersonas =
    repoRoot && repoRoot !== worktreeRoot ? await loadPersonas(repoRoot) : [];

  return mergePersonasWithWorktreePrecedence({
    worktreePersonas,
    repoPersonas,
  });
}

export async function loadPersonaBySlug(
  repoRoot: string,
  slug: string
): Promise<PersonaDefinition | null> {
  if (slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
    throw new Error("Invalid persona slug.");
  }
  const filePath = path.join(repoRoot, PERSONAS_DIR, `${slug}.md`);
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  const { frontmatter, body } = parseFrontmatter(content);
  return {
    slug,
    name: frontmatter.name ?? slug,
    description: frontmatter.description ?? "",
    feedbackFormat: frontmatter.feedbackFormat ?? "findings",
    body,
  };
}

/**
 * Standard review guidance injected into every persona prompt.
 * This keeps submission and thread behavior predictable regardless of what
 * the repo-specific persona markdown contains.
 */
function buildStandardFeedbackGuidance(includeDiff: boolean): string {
  const scopeLine = includeDiff
    ? "- Only flag issues that are within the scope of the changes (the diff below). Do not flag pre-existing issues unless directly caused or worsened by the new changes."
    : "- Only flag issues that are within the scope of the work under review described in the parent context. Do not flag pre-existing issues unless directly caused or worsened by the work under review.";
  const reviewLifecycle = [
    "- Before inspecting the target, call `dispatch_event` with type `working` and a short phase description. Refresh it at distinct review phases so the parent sees accurate progress.",
    "- Inspect the complete review target before submitting. Collect findings during the pass instead of sending direct messages to the parent.",
    "- Call `dispatch_review_submit` exactly once when the initial pass is complete. Always include a concise summary explaining the result. Submit all actionable concerns in the `feedback` array; use an empty array for a clean approval.",
    "- After submission, use `dispatch_review_add_message` for a clarifying question or reply on an existing item. Use `dispatch_review_add_feedback` only for a genuinely new concern.",
    "- Keep all review discussion in feedback-item threads. Do not use direct agent messages for review content.",
    "- Immediately after submitting, call `dispatch_event` with type `done`, or `waiting_user` only if a tracked feedback thread needs a reply. Never leave the agent `working` while waiting. Later thread updates will arrive as structured injected prompts and may start a new turn.",
  ].join("\n");

  return `
## Feedback Guidelines (from Dispatch)

### How to submit feedback
- Submit findings through the \`feedback\` array on \`dispatch_review_submit\`. Each item needs a concrete comment and may include a file path and line range.
${scopeLine}

### Review lifecycle
${reviewLifecycle}

### Feedback hygiene
Submit only actionable concerns or clarifying questions that need a tracked response. Do not create praise-only or informational feedback items. Put the overall assessment and useful positive context in the review summary instead.
`.trim();
}

export type AssemblePersonaPromptOptions = {
  /** When false, omits the git diff section from the prompt. Defaults to true. */
  includeDiff?: boolean;
  /** Runtime that will execute this persona prompt. Cursor gets tool-call hardening. */
  agentType?: Exclude<AgentType, "terminal">;
};

function buildDiffCommands(baseRef: string): string {
  return [
    "### How to inspect changes locally",
    "```bash",
    `git diff ${baseRef}...HEAD -- <path>     # committed changes for one file`,
    `git diff ${baseRef}...HEAD               # full committed diff`,
    "git diff HEAD                            # uncommitted working tree changes",
    "git ls-files --others --exclude-standard # untracked files",
    "```",
  ].join("\n");
}

function buildDiffGuidance(result: ReviewDiffResult): string {
  const { baseRef } = result;
  const sizeKB = Math.round(result.diffByteSize / 1024);
  const hasStat =
    !!result.stat ||
    !!result.uncommittedStat ||
    result.untrackedFiles.length > 0;

  const lines = [
    hasStat
      ? `The full diff is too large to include inline (~${sizeKB}KB). A file-level summary is below — use the provided git commands to inspect specific files in the worktree.`
      : `The full diff is too large to include inline (~${sizeKB}KB). Use the git commands below to inspect changes in the worktree.`,
    "",
  ];

  if (result.stat) {
    lines.push(
      `**Committed changes (vs ${baseRef}):**`,
      "```",
      result.stat,
      "```",
      ""
    );
  }

  if (result.uncommittedStat) {
    lines.push(
      "**Uncommitted working tree changes:**",
      "```",
      result.uncommittedStat,
      "```",
      ""
    );
  }

  if (result.untrackedFiles.length > 0) {
    lines.push(
      "**Untracked files:**",
      ...result.untrackedFiles.map((f) => `- ${f}`),
      ""
    );
  }

  lines.push(buildDiffCommands(baseRef));

  return lines.join("\n");
}

export function assemblePersonaPrompt(
  persona: PersonaDefinition,
  context: string,
  diffResult: ReviewDiffResult | null,
  options: AssemblePersonaPromptOptions = {}
): string {
  const includeDiff = options.includeDiff !== false;

  // Strip legacy {{context}} and {{diff}} placeholders if present — Dispatch
  // now appends these sections automatically so persona files don't need them.
  const personaBody = persona.body
    .replace(/\{\{context\}\}/g, "")
    .replace(/\{\{diff\}\}/g, "");

  const sections: string[] = [personaBody.trimEnd()];
  if (options.agentType === "cursor") {
    sections.push(buildCursorDispatchToolGuidance());
  }
  sections.push(buildStandardFeedbackGuidance(includeDiff));
  sections.push(`## Context from parent agent\n${context}`);
  if (includeDiff && diffResult) {
    if (diffResult.diffByteSize <= INLINE_DIFF_THRESHOLD_BYTES) {
      sections.push(
        `## Changes to review\n${diffResult.diff}\n\n${buildDiffCommands(diffResult.baseRef)}`
      );
    } else {
      sections.push(`## Changes to review\n${buildDiffGuidance(diffResult)}`);
    }
  }

  return sections.join("\n\n");
}
