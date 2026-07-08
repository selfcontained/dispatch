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
 * Standard feedback guidance injected into every persona prompt.
 * This ensures consistent severity definitions and feedback hygiene
 * regardless of what the repo-specific persona markdown contains.
 */
function buildStandardFeedbackGuidance(
  includeDiff: boolean,
  opts: { agentType?: Exclude<AgentType, "terminal"> } = {}
): string {
  const scopeLine = includeDiff
    ? "- Only flag issues that are within the scope of the changes (the diff below). Do not flag pre-existing issues unless directly caused or worsened by the new changes."
    : "- Only flag issues that are within the scope of the work under review described in the parent context. Do not flag pre-existing issues unless directly caused or worsened by the work under review.";
  const cursorCallHint =
    opts.agentType === "cursor"
      ? ' In Cursor, use `functions.dispatch-review_status({ message: "Starting review" })`.'
      : "";
  const reviewLifecycle = [
    `- Call \`review_status\` with a short message when you begin reviewing.${cursorCallHint} Ping it again at meaningful phase changes (e.g. "Reading diff", "Running tests") so the parent can see what you're working on.`,
    "- Call `dispatch_feedback` for each finding as you go.",
    '- When finished with this round, call `dispatch_complete_review` with a `verdict` (`approve` or `request_changes`) and a `summary`. This is the single canonical completion call; do not also try `review_status` with a "complete" status — that path has been removed and the schema will reject it.',
    "- Emit a terminal `dispatch_event` (type `done` or `idle`) to signal end of turn.",
  ].join("\n");

  return `
## Feedback Guidelines (from Dispatch)

### How to submit feedback
- Call \`dispatch_feedback\` for each finding with: severity, description, and a concrete suggestion. Include file path and line number when applicable.
${scopeLine}

### Review lifecycle
${reviewLifecycle}

### Severity levels
- **critical**: Exploitable vulnerability, data loss risk, or broken core functionality
- **high**: Significant issue that should be fixed before merge
- **medium**: Missing validation, weak error handling, or correctness concern
- **low**: Minor issue, hardening opportunity, or improvement suggestion
- **info**: Non-obvious good decision that a future contributor might mistakenly undo

### Info feedback limits — STRICT
Do NOT submit positive affirmations, praise, or "good job" feedback. Feedback like "Good defense-in-depth...", "Good design decision...", or "This is well-structured..." is noise and will be ignored — do not submit it. The \`info\` severity is ONLY for non-obvious decisions that a future contributor might mistakenly undo. Limit to at most 2 items per review. If you have nothing critical to preserve, submit zero info items.
`.trim();
}

const RECHECK_ROUND_TRIP_GUIDANCE = `
## Recheck round-trip

This is a two-round review. You have a round-1 obligation (already described above) AND a round-2 obligation described below. Do not emit a terminal \`dispatch_event\` until BOTH rounds are complete or the recheck has been explicitly cancelled.

**After round 1.** Once you've submitted your initial verdict via \`dispatch_complete_review\`, do not exit. The server will push a short prompt into your terminal here when the parent submits their resolution. When that prompt arrives, call \`dispatch_get_recheck_context\` to fetch the parent's resolution summary, per-item resolutions, and the exact commit range to inspect with local \`git diff\`. There is no tool to poll while waiting for that prompt. Keep this turn alive however your agent runtime allows, and act on it when it arrives. If the parent cancels the recheck, you'll receive a cancellation prompt instead — wrap up cleanly when you see it.

**Round 2.** When the round-2 prompt arrives, re-evaluate each original finding against what the parent actually did. For every original concern that remains unresolved, submit a new \`dispatch_feedback\` item with \`respondsToFeedbackId\` set to the original feedback item's ID so the parent can see which round-2 findings map back to which round-1 concerns. If the parent fully addressed everything, submit no new feedback and approve.

**Mandatory round-2 close.** After you finish round 2 — whether you found new issues or not — you MUST call \`dispatch_complete_review\` a second time with your round-2 verdict (\`approve\` or \`request_changes\`) and a fresh \`summary\`. The review is not closed until you do this. Only then emit a terminal \`dispatch_event\`.
`.trim();

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
  sections.push(
    buildStandardFeedbackGuidance(includeDiff, {
      agentType: options.agentType,
    })
  );
  sections.push(RECHECK_ROUND_TRIP_GUIDANCE);
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
