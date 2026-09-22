import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { AgentType } from "../agents/types.js";
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
 * This prompt travels to the engine as one system-prompt argument, and a
 * command line has a ceiling somewhere above 16KB; overshooting once left
 * a reviewer unstartable, so the size is enforced here — at assembly, on the raw
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
function buildStandardFeedbackGuidance(
  includeDiff: boolean,
  parentAgentId: string | null
): string {
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
  const target = parentAgentId
    ? `the agent that launched you (post with to: "${parentAgentId}")`
    : "the agent that launched you (post with to set to its id)";

  return `
## Feedback Guidelines (from Dispatch)

### How to review
${inspectionSteps.join("\n")}
3. Perform any domain-specific investigation described in your persona instructions above.
4. Collect your findings and post them as described below.

### How to submit feedback
- When the pass is complete, post exactly one \`review\` block to ${target}: \`post({ to, review: { summary, findings: [{ severity, title, body, path, line }] } })\`. Each finding needs a concrete comment and may name a file path and line. A clean pass is a review with no findings; the summary then carries the assessment. The post returns each finding's id.
${scopeLine}

### After posting
- Each finding is a block with its own thread. The agent whose work it is answers under a finding with what it changed or why it disagrees, and that reaches you as a prompt. Check the change, then settle the finding yourself: \`update({ id: <finding id>, state: { status: "fixed" } })\`, or \`{ status: "dismissed", note }\` when its answer convinces you. If it falls short, reply under the finding with what is still missing (\`post({ replyTo: <finding id>, text })\`); reopen one you settled with \`{ status: "open", note }\`. Where the review stands comes from its findings.
- Keep each finding's discussion in its own thread. A genuinely new concern is a reply under the closest finding, not a second review. If the two of you cannot settle one, ask the user there.

### Feedback hygiene
- Findings are actionable concerns or clarifying questions that need a tracked response. Do not create praise-only or informational findings. Put the overall assessment and useful positive context in the summary instead.
- Make each finding actionable: include a concrete suggestion for what to change. Avoid abstract observations like "this could be cleaner" — specify what the better structure looks like and where to apply it.
`.trim();
}

export type AssemblePersonaPromptOptions = {
  /** When false, omits the git diff section from the prompt. Defaults to true. */
  includeDiff?: boolean;
  /** Runtime that will execute this persona prompt. Cursor gets tool-call hardening. */
  agentType?: Exclude<AgentType, "terminal">;
  /** The launcher, so the guidance can say where to post the result. */
  parentAgentId?: string | null;
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
  sections.push(
    buildStandardFeedbackGuidance(includeDiff, options.parentAgentId ?? null)
  );
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
