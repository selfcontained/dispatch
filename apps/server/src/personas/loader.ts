import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { AgentType } from "../agents/types.js";
import { buildCursorDispatchToolGuidance } from "../shared/mcp/cursor-dispatch-guidance.js";
import { appendBuiltInPersonas, BUILT_IN_PERSONAS } from "./built-in.js";
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

/**
 * Hard ceiling on the assembled persona prompt.
 *
 * This prompt is handed to the CLI as an `--append-system-prompt`
 * argument, and on a restart that argument is re-escaped into the
 * `tmux new-session` command, which tmux refuses somewhere above 16KB.
 * Overshooting produced `command too long` and left the reviewer
 * unstartable, so the size is enforced here — at assembly, on the raw
 * text — rather than discovered at launch. 8KB leaves room for the
 * launch guidance, MCP config and env prefix that share that budget.
 *
 * Trimming is visible in the prompt (see `capPromptSection`); a
 * reviewer that lost part of its briefing should be able to tell.
 */
export const MAX_PERSONA_PROMPT_BYTES = 8 * 1024;

/** Per-section ceiling for the file-level stat blocks. */
const MAX_STAT_LINES = 40;

/**
 * Truncate to a byte budget on a line boundary, leaving a marker so the
 * reviewer knows something is missing rather than silently reading a
 * half-briefing as if it were whole.
 */
function capText(value: string, maxBytes: number, what: string): string {
  const total = Buffer.byteLength(value, "utf-8");
  if (total <= maxBytes) return value;

  // Reserve room for the marker first — it is part of the output, so a
  // budget that only covers the kept lines overshoots by its length.
  const marker = (omittedKB: number) =>
    `\n[${what} trimmed — ${omittedKB}KB omitted; read the worktree directly]`;
  const budget = Math.max(
    0,
    maxBytes - Buffer.byteLength(marker(9999), "utf-8")
  );

  const kept: string[] = [];
  let used = 0;
  for (const line of value.split("\n")) {
    const cost = Buffer.byteLength(line, "utf-8") + 1;
    if (used + cost > budget) break;
    kept.push(line);
    used += cost;
  }
  return `${kept.join("\n")}${marker(Math.ceil((total - used) / 1024))}`;
}

/** Cap a stat block by line count, noting how many files were dropped. */
function capStat(stat: string): string {
  const lines = stat.split("\n");
  if (lines.length <= MAX_STAT_LINES) return stat;
  const kept = lines.slice(0, MAX_STAT_LINES);
  return `${kept.join("\n")}\n… and ${lines.length - MAX_STAT_LINES} more (use the git commands below)`;
}

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

  return appendBuiltInPersonas(
    mergePersonasWithWorktreePrecedence({
      worktreePersonas,
      repoPersonas,
    }),
    BUILT_IN_PERSONAS
  );
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
  const inspectionSteps = includeDiff
    ? [
        "1. Read the diff carefully first to understand exactly what changed.",
        "2. Explore surrounding code to understand context and existing patterns.",
      ]
    : [
        "1. Read the parent context and supplied review target carefully first.",
        "2. Explore supporting material as needed to understand the target in context.",
      ];
  const scopeLine = includeDiff
    ? "- Only flag issues that are within the scope of the changes (the diff below). Do not flag pre-existing issues unless directly caused or worsened by the new changes."
    : "- Only flag issues that are within the scope of the work under review described in the parent context. Do not flag pre-existing issues unless directly caused or worsened by the work under review.";
  const reviewLifecycle = [
    "- Before inspecting the target, call `dispatch_event` with type `working` and a short phase description. Refresh it at distinct review phases so the parent sees accurate progress.",
    "- Inspect the complete review target before submitting. Collect findings during the pass instead of sending direct messages to the parent.",
    "- Call `dispatch_review_submit` exactly once when the initial pass is complete. Put actionable concerns in the `feedback` array. When findings are submitted, omit the summary unless one short (280 characters or fewer), non-duplicative overall takeaway is useful; never repeat feedback-item details there. Use an empty array and a concise nonblank summary for a clean approval.",
    "- After submission, use `dispatch_review_add_message` for a clarifying question or reply on an existing item. Use `dispatch_review_add_feedback` only for a genuinely new concern.",
    "- Keep all review discussion in feedback-item threads. Do not use direct agent messages for review content.",
    "- Immediately after submitting, call `dispatch_event` with type `done`, or `waiting_user` only if a tracked feedback thread needs a reply. Never leave the agent `working` while waiting. Later thread updates will arrive as structured injected prompts and may start a new turn.",
  ].join("\n");

  return `
## Feedback Guidelines (from Dispatch)

### How to review
${inspectionSteps.join("\n")}
3. Perform any domain-specific investigation described in your persona instructions above.
4. Collect your findings and submit them as described below.

### How to submit feedback
- Submit findings through the \`feedback\` array on \`dispatch_review_submit\`. Each item needs a concrete comment and may include a file path and line range.
${scopeLine}

### Review lifecycle
${reviewLifecycle}

### Feedback hygiene
- Submit only actionable concerns or clarifying questions that need a tracked response. Do not create praise-only or informational feedback items. Put the overall assessment and useful positive context in the review summary instead.
- Make each finding actionable: include a concrete suggestion for what to change. Avoid abstract observations like "this could be cleaner" — specify what the better structure looks like and where to apply it.
- If everything looks good, say so in the review summary and approve with an empty feedback array. Every feedback item should identify an actionable concern or clarifying question that needs a tracked response.
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

function buildChangeMap(result: ReviewDiffResult): string {
  if (!result.hasChanges) {
    return [
      "No committed or uncommitted changes were detected against " +
        `${result.baseRef}. Confirm with the commands below before ` +
        "concluding there is nothing to review.",
      "",
      buildDiffCommands(result.baseRef),
    ].join("\n");
  }

  const baseName = result.baseRef.replace(/^origin\//, "");
  const lines = [
    "A file-level map of the change is below. The diff itself is not " +
      "included — you are running in the worktree, so read the hunks you " +
      "care about with the commands at the end of this section. They are " +
      "authoritative; this map may be stale if work continued after you " +
      "were launched.",
    "",
  ];

  if (result.stat) {
    lines.push(
      `**Committed changes (vs ${baseName}):**`,
      "```",
      capStat(result.stat),
      "```",
      ""
    );
  }

  if (result.uncommittedStat) {
    lines.push(
      "**Uncommitted working tree changes:**",
      "```",
      capStat(result.uncommittedStat),
      "```",
      ""
    );
  }

  if (result.untrackedFiles.length > 0) {
    const shown = result.untrackedFiles.slice(0, MAX_STAT_LINES);
    lines.push(
      "**Untracked files:**",
      ...shown.map((f) => `- ${f}`),
      ...(result.untrackedFiles.length > shown.length
        ? [`- … and ${result.untrackedFiles.length - shown.length} more`]
        : []),
      ""
    );
  }

  lines.push(buildDiffCommands(result.baseRef));

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
  sections.push(
    `## Context from parent agent\n${capText(context, MAX_PERSONA_PROMPT_BYTES / 2, "Briefing")}`
  );
  if (includeDiff && diffResult) {
    sections.push(`## Changes to review\n${buildChangeMap(diffResult)}`);
  }

  // Belt and braces. The per-section caps above cover the two inputs that
  // actually grow (briefing, change map), but a persona file is authored
  // by hand and nothing bounds it — and blowing the budget costs a
  // reviewer that cannot be restarted at all.
  return capText(
    sections.join("\n\n"),
    MAX_PERSONA_PROMPT_BYTES,
    "Persona prompt"
  );
}
